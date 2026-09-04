# MIDI controllers

Mixerx can read a MIDI controller through the browser's Web MIDI API.
Access is opt-in: open **Settings → MIDI controller** and enable it.
If the API is unavailable, the panel reports that limitation.

## Learn a control

1. Enable MIDI and grant browser permission when prompted.
2. Select **Learn** beside a Mixerx control.
3. Move the physical knob, fader, or pad that should drive it.
4. Use the remove control beside a mapping to forget it.

The first message carrying a value binds the control. Reusing a message removes
its previous binding, so one physical input does not accidentally drive two
controls. Layouts are stored per port name in this browser.

## Mappable controls

| Group | Controls |
| --- | --- |
| Mixer | Crossfader, master, cue level, and each deck's trim, EQ, filter, and level |
| Decks | Play, cue, sync, and hot cues 1–8 |
| Stage | Intensity, blackout, crowd, scenes 1–9, and presets 1–9 |

Continuous controls use **soft takeover**: a physical control must reach the
software value within 2%, or cross it, before it takes over. This prevents a
jump when connecting a controller or changing a mapping.

## Messages and privacy

- Control-change values map from 0–127 into the target control's range.
- Note-on messages and control changes of 64 or higher fire triggers or toggles.
  A note-on with zero velocity is treated as note-off.
- Pitch bend, aftertouch, program change, and MIDI clock are ignored.
- Access uses `sysex: false`. The app sends no MIDI output: no LED feedback,
  motorized-fader commands, or device handshakes.
- Mappings stay in local storage under `mixerx.v2.midi`. They include port names,
  control identifiers, channels, and message numbers.

## Mapping format

The stored object is keyed by port name:

```json
{
  "Example controller": {
    "mixer.crossfader": { "kind": "cc", "channel": 0, "number": 31 },
    "deck.A.play": { "kind": "note", "channel": 0, "number": 11 }
  }
}
```

Channels are zero-based (0–15); message numbers are 0–127. Unknown controls and
invalid bindings are discarded when read. Preserve compatibility when changing
persisted control identifiers.

## Testing without hardware

A development-only virtual controller exercises the same input handler:

```js
await mixerxMidi.connect("Virtual controller");
mixerxMidi.learn("mixer.crossfader");
mixerxMidi.send([0xb0, 31, 64]);
mixerxMidi.send([0xb0, 31, 127]);
mixerxMidi.state();
```

It is available as `window.mixerxMidi` only in development. Virtual-controller
tests cover software behavior, not hardware permissions or device reliability.
