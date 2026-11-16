using System.Diagnostics;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PiAwesomeDesktop;

public sealed class MainForm : Form
{
    private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
    private const string ReleaseBaseUrl = "https://github.com/Gl1ch5555/awesome-pi-agent/releases/download/latest";

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    private readonly WebView2 _webView;
    private readonly string _workingDir;
    private readonly CancellationTokenSource _cts = new();
    private Process? _piProcess;
    private int _port;
    private bool _webViewReady;

    public MainForm(string? initialCwd)
    {
        _workingDir = !string.IsNullOrWhiteSpace(initialCwd) && Directory.Exists(initialCwd)
            ? initialCwd
            : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

        Text = "Pi Awesome";
        Width = 1280;
        Height = 840;
        MinimumSize = new Size(420, 560);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(24, 24, 27);
        ForeColor = Color.FromArgb(228, 228, 231);

        try
        {
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        }
        catch
        {
            // ignore icon extraction issues
        }

        _webView = new WebView2
        {
            Dock = DockStyle.Fill,
            DefaultBackgroundColor = Color.FromArgb(24, 24, 27),
        };
        Controls.Add(_webView);

        Load += OnLoadAsync;
        FormClosing += OnFormClosing;
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        try
        {
            int dark = 1;
            DwmSetWindowAttribute(Handle, DWMWA_USE_IMMERSIVE_DARK_MODE, ref dark, sizeof(int));
        }
        catch
        {
            // ignore on older Windows builds
        }
    }

    private async void OnLoadAsync(object? sender, EventArgs e)
    {
        try
        {
            var userDataDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "PiAwesome",
                "WebView2");
            Directory.CreateDirectory(userDataDir);

            var env = await CoreWebView2Environment.CreateAsync(null, userDataDir);
            await _webView.EnsureCoreWebView2Async(env);
            _webViewReady = true;

            ConfigureWebView(_webView.CoreWebView2);
            ShowLoadingHtml("Запуск агента...", "Инициализация локального сервера Pi Awesome");

            await StartAgentAndNavigateAsync(_cts.Token);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            var res = MessageBox.Show(
                "Для работы Pi Awesome требуется Microsoft Edge WebView2 Runtime.\nОткрыть страницу загрузки?",
                "Pi Awesome",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning);
            if (res == DialogResult.Yes)
            {
                OpenExternalUrl("https://developer.microsoft.com/en-us/microsoft-edge/webview2/");
            }
            Close();
        }
        catch (Exception ex)
        {
            if (_webViewReady)
            {
                ShowErrorHtml("Не удалось запустить Pi Awesome", ex.Message);
            }
            else
            {
                MessageBox.Show($"Ошибка запуска: {ex.Message}", "Pi Awesome", MessageBoxButtons.OK, MessageBoxIcon.Error);
                Close();
            }
        }
    }

    private void ConfigureWebView(CoreWebView2 core)
    {
        core.Settings.AreDefaultContextMenusEnabled = true;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDevToolsEnabled = true;

        core.PermissionRequested += (_, args) =>
        {
            if (args.Uri.StartsWith($"http://127.0.0.1:{_port}", StringComparison.OrdinalIgnoreCase) &&
                (args.PermissionKind == CoreWebView2PermissionKind.Microphone ||
                 args.PermissionKind == CoreWebView2PermissionKind.ClipboardRead))
            {
                args.State = CoreWebView2PermissionState.Allow;
            }
        };

        core.NewWindowRequested += (_, args) =>
        {
            if (!args.Uri.StartsWith($"http://127.0.0.1:{_port}", StringComparison.OrdinalIgnoreCase))
            {
                args.Handled = true;
                OpenExternalUrl(args.Uri);
            }
        };
    }

    private async Task StartAgentAndNavigateAsync(CancellationToken ct)
    {
        var piExe = FindPiExecutable();
        if (piExe == null)
        {
            piExe = await DownloadPrebuiltPiAsync(ct);
        }

        _port = FindFreePort();
        ShowLoadingHtml("Запуск Pi Awesome...", $"Порт 127.0.0.1:{_port}");

        var psi = new ProcessStartInfo
        {
            FileName = piExe,
            Arguments = $"--web-only --web-port {_port}",
            WorkingDirectory = _workingDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        psi.Environment["PI_WEB_PORT"] = _port.ToString();
        psi.Environment["PI_WEB_HOSTNAME"] = "127.0.0.1";

        _piProcess = new Process { StartInfo = psi, EnableRaisingEvents = true };
        var stderrBuffer = new StringBuilder();
        var serverReadyUrl = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);

        _piProcess.OutputDataReceived += (_, ev) =>
        {
            if (string.IsNullOrEmpty(ev.Data)) return;
            const string prefix = "Web UI running: ";
            if (ev.Data.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                serverReadyUrl.TrySetResult(ev.Data[prefix.Length..].Trim());
            }
        };
        _piProcess.ErrorDataReceived += (_, ev) =>
        {
            if (!string.IsNullOrEmpty(ev.Data) && stderrBuffer.Length < 4096)
            {
                stderrBuffer.AppendLine(ev.Data);
            }
        };
        _piProcess.Exited += (_, _) =>
        {
            if (!serverReadyUrl.Task.IsCompleted)
            {
                var err = stderrBuffer.ToString().Trim();
                serverReadyUrl.TrySetException(new InvalidOperationException(
                    string.IsNullOrEmpty(err) ? $"pi.exe exited with code {_piProcess.ExitCode}" : err));
            }
        };

        if (!_piProcess.Start())
        {
            throw new InvalidOperationException("Не удалось запустить процесс pi.exe");
        }
        _piProcess.BeginOutputReadLine();
        _piProcess.BeginErrorReadLine();

        var url = await WaitForServerAsync(serverReadyUrl.Task, _port, ct);
        if (!ct.IsCancellationRequested)
        {
            _webView.CoreWebView2.Navigate(url);
        }
    }

    private static async Task<string> WaitForServerAsync(Task<string> stdoutTask, int port, CancellationToken ct)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromMilliseconds(800) };
        var fallbackUrl = $"http://127.0.0.1:{port}";
        var deadline = DateTime.UtcNow.AddSeconds(30);

        while (DateTime.UtcNow < deadline && !ct.IsCancellationRequested)
        {
            if (stdoutTask.IsFaulted)
            {
                await stdoutTask; // throws
            }
            if (stdoutTask.IsCompletedSuccessfully)
            {
                return stdoutTask.Result;
            }

            try
            {
                using var resp = await http.GetAsync($"{fallbackUrl}/api/state", ct);
                if ((int)resp.StatusCode < 500)
                {
                    return fallbackUrl;
                }
            }
            catch
            {
                // still starting
            }

            await Task.Delay(150, ct);
        }

        throw new TimeoutException("Таймаут ожидания запуска локального сервера Pi Awesome (30 сек).");
    }

    private static string? FindPiExecutable()
    {
        var sameDir = Path.Combine(AppContext.BaseDirectory, "pi.exe");
        if (File.Exists(sameDir)) return sameDir;

        var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var piRoot = Path.Combine(userProfile, ".pi-awesome");
        var appExe = Path.Combine(piRoot, "app", "pi.exe");
        if (File.Exists(appExe)) return appExe;

        var versionsDir = Path.Combine(piRoot, "versions");
        if (Directory.Exists(versionsDir))
        {
            var latest = Directory.GetDirectories(versionsDir)
                .OrderByDescending(d => d, StringComparer.OrdinalIgnoreCase)
                .Select(d => Path.Combine(d, "pi.exe"))
                .FirstOrDefault(File.Exists);
            if (latest != null) return latest;
        }

        var pathEnv = Environment.GetEnvironmentVariable("PATH") ?? "";
        foreach (var dir in pathEnv.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(dir.Trim(), "pi.exe");
            if (File.Exists(candidate)) return candidate;
        }

        return null;
    }

    private async Task<string> DownloadPrebuiltPiAsync(CancellationToken ct)
    {
        var arch = RuntimeInformation.OSArchitecture == Architecture.Arm64 ? "arm64" : "x64";
        var assetName = $"pi-windows-{arch}.zip";
        var url = $"{ReleaseBaseUrl}/{assetName}";

        var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var appDir = Path.Combine(userProfile, ".pi-awesome", "app");
        var tempZip = Path.Combine(Path.GetTempPath(), $"pi-windows-{arch}-{Guid.NewGuid():N}.zip");
        var stageDir = Path.Combine(Path.GetTempPath(), $"pi-stage-{Guid.NewGuid():N}");

        ShowLoadingHtml("Загрузка Pi Awesome...", $"Скачивание {assetName}");

        using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(5) };
        http.DefaultRequestHeaders.UserAgent.ParseAdd("PiAwesomeDesktop/1.0");

        using (var resp = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct))
        {
            resp.EnsureSuccessStatusCode();
            var total = resp.Content.Headers.ContentLength ?? -1L;
            await using var src = await resp.Content.ReadAsStreamAsync(ct);
            await using var dst = File.Create(tempZip);
            var buffer = new byte[65536];
            long readTotal = 0;
            int read;
            var lastReport = DateTime.UtcNow;

            while ((read = await src.ReadAsync(buffer, ct)) > 0)
            {
                await dst.WriteAsync(buffer.AsMemory(0, read), ct);
                readTotal += read;
                if (total > 0 && (DateTime.UtcNow - lastReport).TotalMilliseconds > 150)
                {
                    var pct = (int)(readTotal * 100 / total);
                    var mbDone = (readTotal / 1048576.0).ToString("0.0");
                    var mbTotal = (total / 1048576.0).ToString("0.0");
                    ShowLoadingHtml("Загрузка Pi Awesome...", $"{pct}% · {mbDone} / {mbTotal} MB");
                    lastReport = DateTime.UtcNow;
                }
            }
        }

        ShowLoadingHtml("Распаковка...", "Установка локального агента");
        ZipFile.ExtractToDirectory(tempZip, stageDir, overwriteFiles: true);
        if (Directory.Exists(appDir))
        {
            Directory.Delete(appDir, recursive: true);
        }
        Directory.CreateDirectory(Path.GetDirectoryName(appDir)!);
        Directory.Move(stageDir, appDir);

        try { File.Delete(tempZip); } catch { /* ignore */ }

        var exePath = Path.Combine(appDir, "pi.exe");
        if (!File.Exists(exePath))
        {
            throw new FileNotFoundException("В загруженном архиве отсутствует pi.exe", exePath);
        }
        return exePath;
    }

    private static int FindFreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    private void ShowLoadingHtml(string title, string subtitle)
    {
        if (!_webViewReady) return;
        var html = $$"""
            <!doctype html>
            <html lang="ru">
            <head>
              <meta charset="utf-8" />
              <style>
                * { box-sizing: border-box; margin: 0; padding: 0; }
                body {
                  background: #18181b;
                  color: #e4e4e7;
                  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                  height: 100vh;
                  display: flex;
                  flex-direction: column;
                  align-items: center;
                  justify-content: center;
                  gap: 16px;
                  user-select: none;
                }
                .spinner {
                  width: 28px;
                  height: 28px;
                  border: 2px solid #27272a;
                  border-top-color: #a1a1aa;
                  border-radius: 50%;
                  animation: spin 0.8s linear infinite;
                }
                .title { font-size: 14px; font-weight: 500; letter-spacing: 0.01em; }
                .sub { font-size: 12px; color: #71717a; }
                @keyframes spin { to { transform: rotate(360deg); } }
              </style>
            </head>
            <body>
              <div class="spinner"></div>
              <div class="title">{{WebUtility.HtmlEncode(title)}}</div>
              <div class="sub">{{WebUtility.HtmlEncode(subtitle)}}</div>
            </body>
            </html>
            """;
        if (InvokeRequired)
        {
            BeginInvoke(() => _webView.NavigateToString(html));
        }
        else
        {
            _webView.NavigateToString(html);
        }
    }

    private void ShowErrorHtml(string title, string details)
    {
        if (!_webViewReady) return;
        var html = $$"""
            <!doctype html>
            <html lang="ru">
            <head>
              <meta charset="utf-8" />
              <style>
                * { box-sizing: border-box; margin: 0; padding: 0; }
                body {
                  background: #18181b;
                  color: #e4e4e7;
                  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                  height: 100vh;
                  display: flex;
                  flex-direction: column;
                  align-items: center;
                  justify-content: center;
                  padding: 32px;
                  gap: 12px;
                }
                .box {
                  max-width: 560px;
                  width: 100%;
                  border: 1px solid #27272a;
                  background: #1f1f23;
                  padding: 20px;
                }
                .title { font-size: 15px; font-weight: 600; color: #f4f4f5; margin-bottom: 10px; }
                pre {
                  font-family: ui-monospace, Consolas, monospace;
                  font-size: 12px;
                  color: #a1a1aa;
                  white-space: pre-wrap;
                  word-break: break-word;
                }
              </style>
            </head>
            <body>
              <div class="box">
                <div class="title">{{WebUtility.HtmlEncode(title)}}</div>
                <pre>{{WebUtility.HtmlEncode(details)}}</pre>
              </div>
            </body>
            </html>
            """;
        if (InvokeRequired)
        {
            BeginInvoke(() => _webView.NavigateToString(html));
        }
        else
        {
            _webView.NavigateToString(html);
        }
    }

    private static void OpenExternalUrl(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch
        {
            // ignore
        }
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        _cts.Cancel();
        try
        {
            if (_piProcess is { HasExited: false })
            {
                _piProcess.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            // ignore cleanup errors
        }
        finally
        {
            _piProcess?.Dispose();
            _piProcess = null;
        }
    }
}
