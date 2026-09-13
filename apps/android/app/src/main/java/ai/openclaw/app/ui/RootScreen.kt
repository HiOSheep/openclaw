package ai.openclaw.app.ui

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.i18n.nativeString
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier

internal val LocalGatewayBrowserUnavailableReason = staticCompositionLocalOf<String?> { null }

/** Chooses onboarding or the authenticated app shell from persisted app state. */
@Composable
fun RootScreen(viewModel: MainViewModel) {
  val onboardingCompleted by viewModel.onboardingCompleted.collectAsState()
  val features = rememberWindowDisplayFeatures()
  val access by viewModel.gatewayAccessPresentation.collectAsState()
  val activeId by viewModel.activeGatewayStableId.collectAsState()
  val browserReason =
    if (activeId?.let(access.browserRequired::contains) == true) {
      nativeString("Use native chat for this Access-protected gateway. Open Gateway settings to manage sign-in.")
    } else {
      null
    }

  CompositionLocalProvider(LocalGatewayBrowserUnavailableReason provides browserReason) {
    Column(modifier = Modifier.fillMaxSize()) {
      GatewayAccessStatus(viewModel, access.attention)
      Box(modifier = Modifier.weight(1f)) {
        if (!onboardingCompleted) {
          FoldAwareContent(
            features = features,
            modifier = Modifier.background(MaterialTheme.colorScheme.background),
          ) {
            OnboardingFlow(viewModel = viewModel, modifier = Modifier.fillMaxSize())
          }
        } else {
          ShellScreen(viewModel = viewModel, modifier = Modifier.fillMaxSize(), features = features)
        }
      }
    }
  }
}

/** Shared by onboarding and the app shell so browser return always has a visible outcome. */
@Composable
internal fun GatewayAccessStatus(
  viewModel: MainViewModel,
  attention: ai.openclaw.app.gateway.GatewayAccessAttention?,
) {
  val current = attention ?: return
  Column {
    Text(nativeString(current.message))
    Row {
      if (current.attemptId != null) {
        TextButton(onClick = { viewModel.cancelGatewayAccess(current.attemptId) }) { Text(nativeString("Cancel")) }
      } else {
        TextButton(onClick = viewModel::retryGatewayAccess) { Text(nativeString("Sign in")) }
      }
    }
  }
}
