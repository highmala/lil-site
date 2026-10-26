# Alternative control modes

The original XY interface remains the default. Add `ui=sliders` or `ui=buttons` to any world URL; the world and mode switchers preserve the current selection.

| Mode | URL pattern | Interaction |
| --- | --- | --- |
| XY | `/play` or `/play?world=nature` | Existing draggable/tappable XY field. |
| Two faders | `/play?ui=sliders` or `/play?ui=sliders&world=nature` | X maps hum (0) to glow (1); Y maps sleep (0) to play (1). Arrow keys, Home/End, touch, and drag use native accessible range behavior. |
| Four buttons | `/play?ui=buttons` or `/play?ui=buttons&world=nature` | TL hum+play, TR glow+play, BL hum+sleep, BR glow+sleep. Number keys 1/2/3/4 match those positions. |

Each button press samples a new independent uniform random X and Y inside that quadrant. A 0.04 margin keeps positions away from both outer edges and center boundaries: each axis is sampled from `[0.04, 0.46)` or `[0.54, 0.96)` (the continuous endpoints have no practical distinction).

For a screen-free device, connect two physical faders to the normalized X/Y values, just like the two sliders. For a four-button device, map physical TL/TR/BL/BR buttons to the same four quadrant actions, including re-randomization on every press. The first slider or button interaction calls the same audio-start helper as the original XY field.

Worlds: `default`, `simple`, `simple2`, `nature`, `vocal`, `angelxenakis`, and `pentatonic`. Omitting `world` uses the original synth; explicit `world=default` uses its world definition.
