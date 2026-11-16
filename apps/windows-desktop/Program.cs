namespace PiAwesomeDesktop;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();

        string? initialCwd = null;
        for (int i = 0; i < args.Length; i++)
        {
            if ((args[i] == "--cwd" || args[i] == "-C") && i + 1 < args.Length)
            {
                initialCwd = args[i + 1];
                break;
            }
            if (Directory.Exists(args[i]))
            {
                initialCwd = args[i];
                break;
            }
        }

        Application.Run(new MainForm(initialCwd));
    }
}
