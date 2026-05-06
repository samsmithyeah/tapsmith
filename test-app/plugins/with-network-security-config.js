// Expo config plugin that adds a network_security_config.xml trusting
// user-installed CA certificates. Required for Tapsmith's MITM proxy
// to intercept HTTPS traffic on Android API 24+.
const { withAndroidManifest } = require("expo/config-plugins")
const { mkdirSync, writeFileSync } = require("fs")
const { join } = require("path")

const NETWORK_SECURITY_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="true">
    <trust-anchors>
      <certificates src="system" />
      <certificates src="user" />
    </trust-anchors>
  </base-config>
</network-security-config>
`

module.exports = function withNetworkSecurityConfig(config) {
  return withAndroidManifest(config, (mod) => {
    const resDir = join(
      mod.modRequest.platformProjectRoot,
      "app/src/main/res/xml"
    )
    mkdirSync(resDir, { recursive: true })
    writeFileSync(
      join(resDir, "network_security_config.xml"),
      NETWORK_SECURITY_CONFIG
    )

    const app = mod.modResults.manifest.application?.[0]
    if (app) {
      app.$["android:networkSecurityConfig"] =
        "@xml/network_security_config"
    }

    return mod
  })
}
