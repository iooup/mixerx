# Privacy and data

Mixerx processes music on the device running the browser. It has no
application-owned account service, audio-upload endpoint, telemetry, or analytics.

## Audio and browser storage

Selected files are read locally. Decoded audio is held in memory, not stored in
the library database. IndexedDB retains source handles, metadata, analysis
results, and user edits such as cues and beat-grid corrections.

Preferences use browser storage. The running order and energy history use
session storage. Clearing site data removes stored settings and analyses;
it does not delete the original music files. Folder access may need to be
granted again. A recap export is a local download requested by the user.

## What an agent can see

The built-in agent uses local rules. A compatible external WebMCP agent can read
musical state, track titles, artists, and analysis summaries such as tempo, key,
sections, and energy. Tools omit file paths, file URLs, decoded samples, and
waveform bytes. File-derived text is treated as untrusted content.

An external agent's handling of returned information is outside Mixerx's
control. Do not interpret local audio processing as a promise that an external
agent provider never receives metadata.

Optional explanations use a browser-provided on-device model when available.
That model and any installation or download it requires are managed by the
browser, not bundled with Mixerx.

## Connections and the offline badge

Application scripts, fonts, workers, and artwork are served from the app's own
origin. The Console and Stage use `connect-src 'self'` and make no
application-owned external API calls for mixing or analysis. Same-origin asset
loads still occur; this is not a claim of zero HTTP traffic.

The offline badge checks whether the browser blocks a deliberate request to
`https://csp-probe.invalid/mixerx` through Content Security Policy. A matching
policy-violation event confirms that probe was blocked. A failed fetch alone
does not prove it. The badge is not an audit of browser extensions, agent hosts,
or the hosting provider.

Mixerx does not provide an offline-installation/service-worker workflow.
To use it without an internet connection, serve a locally installed build;
access to a remote website is a separate requirement.

## Stage windows and hardware

Stage windows receive features, settings, musical events, and limited
now-playing metadata over a same-origin session channel, never audio samples.
The metadata can include track names, artist names, and a small embedded-artwork
thumbnail.

Audio Setup may request microphone permission to reveal output-device labels;
its enumeration stream is stopped after use. MIDI access is opt-in and
input-only, without system-exclusive messages or device output.

## Introduction-page video

The separate introduction website has an optional YouTube recording.
The player is not created until the visitor activates it. At that point the
browser connects to YouTube, whose own policies apply. Its local poster does not
require a remote thumbnail request.

This exception belongs only to the introduction page, not to Console or Stage.
