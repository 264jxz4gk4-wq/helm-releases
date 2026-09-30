plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// ---------------------------------------------------------------------------
// Version comes from the repo-root version.json, the same file the Mac and
// Windows builds and the desktop auto-updater read. One number, everywhere.
// 1.2.0 -> versionCode 10200.
// ---------------------------------------------------------------------------
val helmVersion: String = run {
    val json = rootProject.file("../version.json").readText()
    Regex("\"version\"\\s*:\\s*\"([0-9]+\\.[0-9]+\\.[0-9]+)\"").find(json)
        ?.groupValues?.get(1)
        ?: error("Could not read \"version\" from ../version.json")
}
val helmVersionCode: Int = helmVersion.split(".").map(String::toInt)
    .let { (major, minor, patch) -> major * 10000 + minor * 100 + patch }

// Release signing. CI passes these as environment variables decoded from
// repository secrets. Local builds without them fall back to the debug key,
// which is fine for testing but can't update a CI-signed install.
val releaseKeystore: String? = System.getenv("HELM_KEYSTORE_FILE")

android {
    namespace = "com.helm.tv"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.helm.tv"
        // 19 = Android 4.4 KitKat. The target tablet, a Galaxy Tab 3 7.0, runs
        // CyanogenMod 11 (Android 4.4.4). No androidx: appcompat needs 21.
        minSdk = 19
        targetSdk = 34
        versionCode = helmVersionCode
        versionName = helmVersion

        ndk {
            // Only ABIs we ship an adb binary for (this also trims Conscrypt's
            // x86 libraries). The Tab 3's PXA988 is a 32-bit Cortex-A9.
            abiFilters += listOf("armeabi-v7a", "arm64-v8a")
        }
    }

    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = System.getenv("HELM_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("HELM_KEY_ALIAS")
                keyPassword = System.getenv("HELM_KEY_PASSWORD")
                enableV1Signing = true   // the only scheme Android < 7.0 checks
                enableV2Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (releaseKeystore != null)
                signingConfigs.getByName("release")
            else
                signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    // CRITICAL for the bundled adb binary: it ships as jniLibs/<abi>/libadb.so.
    // Android only makes nativeLibraryDir executable, and only extracts files
    // there when legacy packaging is on (android:extractNativeLibs="true").
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    lint {
        // lintVital runs on every release build. Make calling an API newer
        // than minSdk without an SDK_INT guard a build failure: that exact
        // mistake crashes on the Android 7 tablet this is built for.
        fatal += "NewApi"
        // These concern Google Play's publishing deadlines, not whether the
        // app runs. Helm ships as a sideloaded APK, so don't let them fail CI.
        disable += setOf("ExpiredTargetSdkVersion", "ExpiringTargetSdkVersion", "OldTargetApi")
        checkReleaseBuilds = true
        abortOnError = true
    }
}

dependencies {

    // Embedded HTTP server. NanoHTTPD is one small jar, runs on any Android
    // version, and uses a thread per request - which suits blocking adb calls
    // and a 1 GB device far better than a coroutine server stack.
    implementation("org.nanohttpd:nanohttpd:2.3.1")

    // Modern TLS for APK downloads on Android 4.4 only (see Tls.kt). 2.5.2 is
    // the last Conscrypt release that supports pre-Lollipop Android; 2.6+
    // requires API 21.
    implementation("org.conscrypt:conscrypt-android:2.5.2")
}

// ---------------------------------------------------------------------------
// Fail early and clearly if the generated inputs are missing, instead of
// shipping an APK that installs fine and then does nothing.
// ---------------------------------------------------------------------------
val verifyHelmInputs by tasks.registering {
    doLast {
        val ui = file("src/main/assets/ui/index.html")
        if (!ui.exists()) throw GradleException(
            "Missing ${ui.path}. Run: node tools/sync-ui.mjs  (from HelmAndroid/)"
        )
        listOf("armeabi-v7a", "arm64-v8a").forEach { abi ->
            val adb = file("src/main/jniLibs/$abi/libadb.so")
            if (!adb.exists()) throw GradleException(
                "Missing ${adb.path}. Run: bash tools/fetch-adb.sh  (from HelmAndroid/)"
            )
        }
    }
}
tasks.named("preBuild") { dependsOn(verifyHelmInputs) }
