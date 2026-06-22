# Component Style Bugs

## Bugs

### Buttons

#### Buttons in dark mode

1. The outline and the ghost buttons have incorrect foreground and background colors in dark mode and are invisible to the human eye. The hover states for both buttons render correctly.
2. The hover state of the secondary button has the wrong foreground color making the button text disappear on hover.
3. Disabled buttons need to render the disabled tooltip on hover

### Card

1. Card headers have a almost black background color that needs to be dramatically lighter. There should be just a hint of a difference to the background of card headers in both light and dark mode.
2. (dark mode): The text color does not have enough contrast and is hard to read.

### Panel

1. (dark mode): panel header buttons do not have the right foreground or background colors and the hover state has the incorrect foreground and background colors you can not read the text they are both set to white. The button needs to be an outline button and outline buttons on hover transition to the light background (this works okay) but needs dark text coloring and this is the problem the color is also the same as background. I think this is related to the root cause of the outline button styling in dark mode is generally off.
2. (dark mode): text colors in the app generally in dark mode are hard to read not enough contrast.

### Checkboxes

1. dark mode and light mode: i want the checkbox fill color to not be white i want it to be transparent and i want the outline to render only on unchecked states and the fill is currently correct. in dark mode the outline should be a logical light color and on light mode it should be a logical dark color and by logical i mean dont invent a new color the text foreground color in both states should work fine

### Comboboxes

1. dark mode: i want comboboxes to have a dark background in dark mode.
2. dark/light: the background highlight color on hover of a option needs to match the primary buttons background color and the text needs to match the primary buttons foreground color (on hover only)

### 