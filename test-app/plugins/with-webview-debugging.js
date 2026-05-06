// Expo config plugin that enables WebView debugging in release builds.
// On Android, `react-native-webview` only calls
// WebView.setWebContentsDebuggingEnabled(true) when ReactBuildConfig.DEBUG
// is true. This plugin injects the call into MainApplication.onCreate()
// so it fires unconditionally — required for Tapsmith's WebView testing.
const { withMainApplication } = require("expo/config-plugins")

const IMPORT = "import android.webkit.WebView;"
const ENABLE_CALL = "      WebView.setWebContentsDebuggingEnabled(true);"

module.exports = function withWebviewDebugging(config) {
  return withMainApplication(config, (mod) => {
    let contents = mod.modResults.contents

    if (!contents.includes("setWebContentsDebuggingEnabled")) {
      // Add import if missing
      if (!contents.includes(IMPORT)) {
        contents = contents.replace(
          /(import android\.app\.Application;?)/,
          `$1\n${IMPORT}`
        )
      }

      // Add the call at the start of onCreate()
      contents = contents.replace(
        /(super\.onCreate\(\);?\n)/,
        `$1${ENABLE_CALL}\n`
      )
    }

    mod.modResults.contents = contents
    return mod
  })
}
