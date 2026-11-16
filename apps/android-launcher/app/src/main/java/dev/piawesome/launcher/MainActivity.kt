package dev.piawesome.launcher

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {

    companion object {
        private const val TERMUX_PACKAGE = "com.termux"
        private const val TERMUX_RUN_SERVICE = "com.termux.app.RunCommandService"
        private const val TERMUX_PERMISSION = "com.termux.permission.RUN_COMMAND"
        private const val REQ_TERMUX_PERMISSION = 1001
        private const val PREFS_NAME = "pi_awesome_prefs"
        private const val KEY_DISTRO = "proot_distro"
        private const val SETUP_CMD =
            "mkdir -p ~/.termux && grep -q '^allow-external-apps' ~/.termux/termux.properties 2>/dev/null || echo 'allow-external-apps = true' >> ~/.termux/termux.properties && termux-reload-settings"
    }

    private val handler = Handler(Looper.getMainLooper())
    private lateinit var spinner: ProgressBar
    private lateinit var statusText: TextView
    private lateinit var subText: TextView
    private lateinit var errorCard: LinearLayout
    private lateinit var errorDetail: TextView
    private lateinit var distroInput: EditText
    private lateinit var retryButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildUi()
        scheduleLaunch()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        scheduleLaunch()
    }

    private fun dp(value: Int): Int {
        return TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            value.toFloat(),
            resources.displayMetrics
        ).toInt()
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.parseColor("#18181b"))
            setPadding(dp(24), dp(24), dp(24), dp(24))
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        }

        val logo = TextView(this).apply {
            text = "π"
            textSize = 36f
            typeface = Typeface.MONOSPACE
            setTextColor(Color.parseColor("#e4e4e7"))
            gravity = Gravity.CENTER
            setPadding(0, 0, 0, dp(20))
        }
        root.addView(logo)

        spinner = ProgressBar(this).apply {
            isIndeterminate = true
            indeterminateTintList = ColorStateList.valueOf(Color.parseColor("#a1a1aa"))
            layoutParams = LinearLayout.LayoutParams(dp(32), dp(32)).apply {
                bottomMargin = dp(16)
            }
        }
        root.addView(spinner)

        statusText = TextView(this).apply {
            text = "Запуск Pi Awesome..."
            textSize = 15f
            setTextColor(Color.parseColor("#e4e4e7"))
            gravity = Gravity.CENTER
        }
        root.addView(statusText)

        subText = TextView(this).apply {
            text = "Termux · proot · zsh · pi"
            textSize = 12f
            setTextColor(Color.parseColor("#71717a"))
            gravity = Gravity.CENTER
            setPadding(0, dp(6), 0, dp(20))
        }
        root.addView(subText)

        errorCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            setPadding(dp(16), dp(16), dp(16), dp(16))
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#1f1f23"))
                setStroke(dp(1), Color.parseColor("#27272a"))
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = dp(8)
            }
        }

        errorDetail = TextView(this).apply {
            textSize = 13f
            setTextColor(Color.parseColor("#d4d4d8"))
            setPadding(0, 0, 0, dp(12))
        }
        errorCard.addView(errorDetail)

        val distroLabel = TextView(this).apply {
            text = "proot-distro (пусто = автоопределение):"
            textSize = 11f
            setTextColor(Color.parseColor("#71717a"))
            setPadding(0, 0, 0, dp(4))
        }
        errorCard.addView(distroLabel)

        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        distroInput = EditText(this).apply {
            setText(prefs.getString(KEY_DISTRO, "") ?: "")
            hint = "например: ubuntu"
            setHintTextColor(Color.parseColor("#52525b"))
            setTextColor(Color.parseColor("#e4e4e7"))
            textSize = 13f
            inputType = InputType.TYPE_CLASS_TEXT
            setSingleLine(true)
            setPadding(dp(10), dp(8), dp(10), dp(8))
            background = GradientDrawable().apply {
                setColor(Color.parseColor("#18181b"))
                setStroke(dp(1), Color.parseColor("#27272a"))
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                bottomMargin = dp(12)
            }
        }
        errorCard.addView(distroInput)

        val btnRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
        }

        val copyBtn = makeButton("Команда Termux", "#27272a") {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("Termux allow-external-apps", SETUP_CMD))
            Toast.makeText(this, "Команда скопирована", Toast.LENGTH_SHORT).show()
        }
        btnRow.addView(copyBtn)

        val openTermuxBtn = makeButton("Открыть Termux", "#27272a") {
            openTermuxApp()
        }.apply {
            (layoutParams as LinearLayout.LayoutParams).leftMargin = dp(8)
        }
        btnRow.addView(openTermuxBtn)

        retryButton = makeButton("Повторить", "#3f3f46") {
            saveDistro()
            scheduleLaunch()
        }.apply {
            (layoutParams as LinearLayout.LayoutParams).leftMargin = dp(8)
        }
        btnRow.addView(retryButton)

        errorCard.addView(btnRow)
        root.addView(errorCard)

        setContentView(root)
    }

    private fun makeButton(label: String, bgHex: String, onClick: () -> Unit): Button {
        return Button(this).apply {
            text = label
            isAllCaps = false
            textSize = 12f
            setTextColor(Color.parseColor("#e4e4e7"))
            setPadding(dp(12), dp(8), dp(12), dp(8))
            background = GradientDrawable().apply {
                setColor(Color.parseColor(bgHex))
                setStroke(dp(1), Color.parseColor("#3f3f46"))
            }
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
            setOnClickListener { onClick() }
        }
    }

    private fun saveDistro() {
        val value = distroInput.text.toString().trim()
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_DISTRO, value)
            .apply()
    }

    private fun scheduleLaunch() {
        spinner.visibility = View.VISIBLE
        errorCard.visibility = View.GONE
        statusText.text = "Запуск Pi Awesome..."
        subText.text = "Termux · proot · zsh · pi"

        handler.removeCallbacksAndMessages(null)
        handler.postDelayed({ launchTermuxPi() }, 220)
    }

    private fun isTermuxInstalled(): Boolean {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                packageManager.getPackageInfo(TERMUX_PACKAGE, PackageManager.PackageInfoFlags.of(0))
            } else {
                @Suppress("DEPRECATION")
                packageManager.getPackageInfo(TERMUX_PACKAGE, 0)
            }
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun launchTermuxPi() {
        if (!isTermuxInstalled()) {
            showError(
                "Termux не найден.\nУстановите Termux (F-Droid / GitHub) и настройте proot-distro с zsh и pi-awesome."
            )
            return
        }

        if (checkSelfPermission(TERMUX_PERMISSION) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(TERMUX_PERMISSION), REQ_TERMUX_PERMISSION)
            return
        }

        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val distro = prefs.getString(KEY_DISTRO, "")?.trim().orEmpty()
        val script = buildLaunchScript(distro)

        val intent = Intent("com.termux.RUN_COMMAND").apply {
            setClassName(TERMUX_PACKAGE, TERMUX_RUN_SERVICE)
            putExtra("com.termux.RUN_COMMAND_PATH", "/data/data/com.termux/files/usr/bin/bash")
            putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf("-lc", script))
            putExtra("com.termux.RUN_COMMAND_BACKGROUND", false)
            putExtra("com.termux.RUN_COMMAND_SESSION_ACTION", "0")
        }

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent)
            } else {
                startService(intent)
            }
            statusText.text = "Открытие Termux..."
            handler.postDelayed({
                spinner.visibility = View.GONE
                statusText.text = "Запущено в Termux"
                subText.text = "proot · zsh · pi"
                errorCard.visibility = View.VISIBLE
                errorDetail.text = "Если Termux не открылся автоматически, проверьте allow-external-apps = true в ~/.termux/termux.properties."
            }, 1400)
        } catch (e: Exception) {
            showError(
                "Не удалось запустить команду в Termux: ${e.message}\n\n" +
                    "Убедитесь, что в ~/.termux/termux.properties добавлено allow-external-apps = true (кнопка «Команда Termux»)."
            )
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_TERMUX_PERMISSION) {
            if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                launchTermuxPi()
            } else {
                showError(
                    "Не выдано разрешение com.termux.permission.RUN_COMMAND.\nНажмите «Повторить» и разрешите запуск команд Termux."
                )
            }
        }
    }

    private fun buildLaunchScript(explicitDistro: String): String {
        val safeDistro = explicitDistro.replace(Regex("[^a-zA-Z0-9._-]"), "")
        return buildString {
            append("DISTRO=\"$safeDistro\"; ")
            append("if [ -z \"\$DISTRO\" ] && [ -f \"\$HOME/.pi-awesome-distro\" ]; then DISTRO=\"\$(tr -d '[:space:]' < \"\$HOME/.pi-awesome-distro\")\"; fi; ")
            append("if [ -z \"\$DISTRO\" ]; then ")
            append("ROOTFS_DIR=\"\$PREFIX/var/lib/proot-distro/installed-rootfs\"; ")
            append("for cand in ubuntu debian archlinux alpine; do ")
            append("if [ -d \"\$ROOTFS_DIR/\$cand\" ]; then DISTRO=\"\$cand\"; break; fi; ")
            append("done; ")
            append("if [ -z \"\$DISTRO\" ] && [ -d \"\$ROOTFS_DIR\" ]; then DISTRO=\"\$(ls -1 \"\$ROOTFS_DIR\" 2>/dev/null | head -n1)\"; fi; ")
            append("fi; ")
            append("if [ -n \"\$DISTRO\" ] && command -v proot-distro >/dev/null 2>&1; then ")
            append("exec proot-distro login \"\$DISTRO\" --shared-tmp -- zsh -l -i -c 'if command -v pi-awesome >/dev/null 2>&1; then pi-awesome; elif command -v pi >/dev/null 2>&1; then pi; else echo \"pi-awesome не найден в proot\"; fi; exec zsh -l'; ")
            append("elif command -v proot-distro >/dev/null 2>&1; then ")
            append("echo 'proot-distro не установлен. Пример: proot-distro install ubuntu'; ")
            append("exec zsh -l 2>/dev/null || exec bash -l; ")
            append("else ")
            append("exec zsh -l -i -c 'if command -v pi-awesome >/dev/null 2>&1; then pi-awesome; elif command -v pi >/dev/null 2>&1; then pi; fi; exec zsh -l'; ")
            append("fi")
        }
    }

    private fun openTermuxApp() {
        val launchIntent = packageManager.getLaunchIntentForPackage(TERMUX_PACKAGE)
        if (launchIntent != null) {
            startActivity(launchIntent)
        } else {
            Toast.makeText(this, "Termux не установлен", Toast.LENGTH_SHORT).show()
        }
    }

    private fun showError(message: String) {
        spinner.visibility = View.GONE
        statusText.text = "Требуется настройка"
        subText.text = "Termux · proot · zsh · pi"
        errorDetail.text = message
        errorCard.visibility = View.VISIBLE
    }
}
