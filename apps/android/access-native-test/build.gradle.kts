plugins {
  alias(libs.plugins.android.test)
  alias(libs.plugins.ktlint)
}

android {
  namespace = "ai.openclaw.accessnativetest"
  // Match the target app while targetSdk remains an independent behavior opt-in.
  compileSdk = 37

  defaultConfig {
    minSdk = 31
    targetSdk = 36
    missingDimensionStrategy("store", "play")
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }

  buildTypes {
    create("release") {
      // This self-instrumented fixture is signed independently of the target app.
      signingConfig = signingConfigs.getByName("debug")
    }
  }

  targetProjectPath = ":app"
  experimentalProperties["android.experimental.self-instrumenting"] = true

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
}

androidComponents {
  // This fixture requires the installed app's non-debuggable Release variant.
  beforeVariants(selector().withBuildType("debug")) { variant ->
    variant.enable = false
  }
}

kotlin {
  compilerOptions {
    jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    allWarningsAsErrors.set(true)
  }
}

ktlint {
  version.set(libs.versions.ktlint.cli)
  android.set(true)
  ignoreFailures.set(false)
  filter {
    exclude("**/build/**")
  }
}

dependencies {
  implementation(libs.androidx.test.ext.junit)
  implementation(libs.androidx.test.runner)
}
