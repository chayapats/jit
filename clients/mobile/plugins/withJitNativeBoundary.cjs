const { withAppDelegate, withMainApplication, withMainActivity, withAppBuildGradle, withInfoPlist, withAndroidManifest, withDangerousMod, withPodfileProperties, withGradleProperties, AndroidConfig } = require("expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

const iosBoundary = `    // Modified by Jit: cache/session isolation before native React starts (ADR 0100).
    JitNativeGateRuntime.shared.start()
    ExpoFetchCustomExtension.setCustomURLSessionConfigurationProvider {
      let configuration = URLSessionConfiguration.ephemeral
      configuration.urlCache = nil
      configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
      configuration.httpCookieStorage = nil
      configuration.httpShouldSetCookies = false
      configuration.httpCookieAcceptPolicy = .never
      configuration.timeoutIntervalForRequest = 900
      configuration.timeoutIntervalForResource = 900
      return configuration
    }
`;
const androidLifecycle = `  // Modified by Jit: synchronous native visibility hooks before React lifecycle events (ADR 0100).
  override fun onPause() {
    io.jit.nativegate.JitNativeGateRuntime.background(this)
    super.onPause()
  }

  override fun onResume() {
    io.jit.nativegate.JitNativeGateRuntime.foreground(this)
    super.onResume()
  }

  override fun onDestroy() {
    io.jit.nativegate.JitNativeGateRuntime.destroy(this)
    super.onDestroy()
  }

`;
const androidBoundary = `    // Modified by Jit: no persistent HTTP cache or implicit redirect before React starts (ADR 0100).
    com.facebook.react.modules.network.OkHttpClientProvider.setOkHttpClientFactory(
      object : com.facebook.react.modules.network.OkHttpClientFactory {
        override fun createNewNetworkModuleClient(): okhttp3.OkHttpClient =
          com.facebook.react.modules.network.OkHttpClientProvider.createClientBuilder()
            .cache(null)
            .followRedirects(false)
            .followSslRedirects(false)
            .build()
      }
    )
`;
const networkPolicy = `<?xml version="1.0" encoding="utf-8"?>
<!-- Authored Jit boundary: only literal loopback development traffic may use HTTP. -->
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">127.0.0.1</domain>
    <domain includeSubdomains="false">::1</domain>
  </domain-config>
</network-security-config>
`;

/** Authored config-plugin. Generated platform code keeps Expo/RN provenance; never weakens TLS or adds renderer IPC. */
module.exports = function withJitNativeBoundary(config) {
  config = withAppDelegate(config, result => {
    if (result.modResults.language !== "swift") throw new Error("mobile_app_delegate_unsupported");
    result.modResults.contents = result.modResults.contents.replace(/^import JitNativeGate$/m, "internal import JitNativeGate");
    if (!result.modResults.contents.includes("import JitNativeGate")) result.modResults.contents = "internal import JitNativeGate\n" + result.modResults.contents;
    if (!result.modResults.contents.includes("ExpoFetchCustomExtension.setCustomURLSessionConfigurationProvider")) {
      const anchor = "    let delegate = ReactNativeDelegate()";
      if (result.modResults.contents.split(anchor).length !== 2) throw new Error("mobile_app_delegate_contract_changed");
      result.modResults.contents = result.modResults.contents.replace(anchor, iosBoundary + anchor);
    }
    if (!result.modResults.contents.includes("JitNativeGateRuntime.shared.start()")) {
      const anchor = "    // Modified by Jit: cache/session isolation before native React starts (ADR 0100).";
      if (result.modResults.contents.split(anchor).length !== 2) throw new Error("mobile_app_delegate_contract_changed");
      result.modResults.contents = result.modResults.contents.replace(anchor, anchor + "\n    JitNativeGateRuntime.shared.start()");
    }
    return result;
  });
  config = withMainApplication(config, result => {
    if (result.modResults.language !== "kt") throw new Error("mobile_main_application_unsupported");
    if (!result.modResults.contents.includes("OkHttpClientProvider.setOkHttpClientFactory")) {
      const anchor = "    super.onCreate()";
      if (result.modResults.contents.split(anchor).length !== 2) throw new Error("mobile_main_application_contract_changed");
      result.modResults.contents = result.modResults.contents.replace(anchor, anchor + "\n" + androidBoundary);
    }
    return result;
  });
  config = withMainActivity(config, result => {
    if (result.modResults.language !== "kt") throw new Error("mobile_main_activity_unsupported");
    if (!result.modResults.contents.includes("JitNativeGateRuntime.background(this)")) {
      const anchor = "  override fun getMainComponentName(): String";
      if (result.modResults.contents.split(anchor).length !== 2 || /override fun on(?:Pause|Resume|Destroy)\(/.test(result.modResults.contents)) throw new Error("mobile_main_activity_contract_changed");
      result.modResults.contents = result.modResults.contents.replace(anchor, androidLifecycle + anchor);
    }
    return result;
  });
  config = withPodfileProperties(config, result => { result.modResults.EX_DEV_CLIENT_NETWORK_INSPECTOR = "false"; return result; });
  config = withGradleProperties(config, result => { result.modResults = result.modResults.filter(property => property.type !== "property" || property.key !== "EX_DEV_CLIENT_NETWORK_INSPECTOR"); result.modResults.push({ type: "property", key: "EX_DEV_CLIENT_NETWORK_INSPECTOR", value: "false" }); return result; });
  config = withAppBuildGradle(config, result => {
    // The template's public debug key must never sign a credential-bearing release.
    if (result.modResults.language !== "groovy") throw new Error("mobile_app_gradle_unsupported");
    const source = result.modResults.contents;
    if (!source.includes("// Modified by Jit: releases require an owner's protected signing key.")) {
      const anchor = /release \{([\s\S]*?)signingConfig signingConfigs\.debug/;
      if (!anchor.test(source)) throw new Error("mobile_release_signing_contract_changed");
      result.modResults.contents = source.replace(anchor, "release {$1// Modified by Jit: releases require an owner's protected signing key.\n            signingConfig = null");
    }
    return result;
  });
  config = withInfoPlist(config, result => {
    result.modResults.NSAppTransportSecurity = { NSAllowsArbitraryLoads: false, NSAllowsLocalNetworking: true };
    return result;
  });
  config = withAndroidManifest(config, result => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(result.modResults);
    application.$["android:networkSecurityConfig"] = "@xml/jit_network_security_config";
    application.$["android:usesCleartextTraffic"] = "false";
    application.$["android:allowBackup"] = "false";
    // Modified by Jit: FCM token acquisition is explicit; analytics/automatic collection stay disabled.
    const metadata = { firebase_messaging_auto_init_enabled: "false", firebase_data_collection_default_enabled: "false", firebase_analytics_collection_enabled: "false", firebase_analytics_collection_deactivated: "true", google_analytics_adid_collection_enabled: "false", google_analytics_automatic_screen_reporting_enabled: "false" };
    application["meta-data"] = (application["meta-data"] ?? []).filter(entry => !Object.hasOwn(metadata, entry.$["android:name"]));
    for (const [name, value] of Object.entries(metadata)) application["meta-data"].push({ $: { "android:name": name, "android:value": value } });
    return result;
  });
  config = withDangerousMod(config, ["ios", async result => {
    // Modified by Jit: retain the reviewed effective native dependency selection across CNG regeneration.
    fs.copyFileSync(path.join(result.modRequest.projectRoot, "native-inputs/Podfile.lock"), path.join(result.modRequest.platformProjectRoot, "Podfile.lock"));
    return result;
  }]);
  return withDangerousMod(config, ["android", async result => {
    const directory = path.join(result.modRequest.platformProjectRoot, "app/src/main/res/xml");
    fs.mkdirSync(directory, { recursive: true }); fs.writeFileSync(path.join(directory, "jit_network_security_config.xml"), networkPolicy);
    const gradle = path.join(result.modRequest.platformProjectRoot, "gradle");
    fs.copyFileSync(path.join(result.modRequest.projectRoot, "native-inputs/gradle-verification-metadata.xml"), path.join(gradle, "verification-metadata.xml"));
    const wrapper = path.join(gradle, "wrapper/gradle-wrapper.properties"), source = fs.readFileSync(wrapper, "utf8");
    if (!source.includes("gradle-9.4.1-bin.zip")) throw new Error("mobile_gradle_wrapper_contract_changed");
    fs.writeFileSync(wrapper, source.replace(/^distributionSha256Sum=.*\n?/gm, "") + "\n# Modified by Jit: verify the pinned official Gradle distribution.\ndistributionSha256Sum=2ab2958f2a1e51120c326cad6f385153bb11ee93b3c216c5fccebfdfbb7ec6cb\n");
    return result;
  }]);
};
