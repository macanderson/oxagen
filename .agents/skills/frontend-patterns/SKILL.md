---
name: frontend-patterns
description: Library of 136 action-oriented web-platform technique guides — HTML semantics, modern CSS & layout, accessibility, performance & Core Web Vitals (LCP/INP/CLS), forms & autofill, passkeys/WebAuthn, view transitions, scroll-driven animation, privacy, security, built-in browser AI, and WebMCP. Use when building or reviewing UI in apps/app or apps/website — find the specific technique in the index below and read that file before implementing.
---

# Frontend patterns

A curated, high-density reference library. Each entry below is a self-contained
guide that lives in `techniques/<id>.md`. **Workflow:** scan the index, open the
one or two files that match the task, implement from them. Don't read the whole
library — progressive disclosure is the point.

Pairs with **oxagen-engineering-policy**
(the binding rules, including mobile-first and accessibility non-negotiables).

## Index

### HTML & semantics

- [`html`](techniques/html.md) — Action-oriented guidelines for modern HTML architecture, semantics, native interactive APIs (Dialog, Popover, Details), focus management, and resource prioritization. Use this guide when structuring web documents, implementing native overlays, or optimizing resource loading order.

### CSS

- [`css`](techniques/css.md) — Action-oriented guidelines for modern CSS architecture, layouts, and performance. Use this guide when authoring styles, managing design systems, or optimizing web rendering.
- [`highlight-text-ranges`](techniques/highlight-text-ranges.md) — Highlight arbitrary text ranges on a page such as search results, spelling errors, or collaborative editing cursors.

### CSS layout

- [`css-layout`](techniques/css-layout.md) — Modern CSS layouts such as flexbox, grid, subgrid, container queries, anchor positioning, and intrinsic sizing. Use this skill when architecting responsive UI components or page layouts.

### User experience & interaction

- [`adapt-scrollbar-to-contrast-preferences`](techniques/adapt-scrollbar-to-contrast-preferences.md) — Enhance scrollbar visibility for users who prefer high-contrast interfaces
- [`anchor-positioning-tab-underline`](techniques/anchor-positioning-tab-underline.md) — Transition an element seamlessly between two target element positions. For example, moving a selected tab underline between the previously selected tab and the currently selected tab.
- [`animate-element-entry-exit`](techniques/animate-element-entry-exit.md) — Smoothly hide/show elements as they are added/removed from the DOM or as their display values are toggled.
- [`animate-to-from-top-layer`](techniques/animate-to-from-top-layer.md) — Animate elements such as dialogs, popovers, and tooltips as they're entering/exiting the top layer.
- [`animate-to-intrinsic-sizes`](techniques/animate-to-intrinsic-sizes.md) — Smoothly animate interactive components (like accordions, menus, and expanding cards) to and from their natural dimensions.
- [`apply-webgl-shaders`](techniques/apply-webgl-shaders.md) — Apply custom visual effects with WebGL shaders to HTML content.
- [`calculate-event-differentials`](techniques/calculate-event-differentials.md) — Calculate the duration and time remaining between dates and times.
- [`calculate-with-intrinsic-sizes`](techniques/calculate-with-intrinsic-sizes.md) — Calculate the size of an element based on its intrinsic size, while ensuring it fits within given design constraints.
- [`capture-location-agnostic-data`](techniques/capture-location-agnostic-data.md) — Record chronological data that should not change based on a user's location, such as birthdates, recurring alarms, or national holidays.
- [`carousel-slide-effects`](techniques/carousel-slide-effects.md) — Create a carousel of slides with images or other visual elements, where each slide animates as they enter/center/exit their scroller. For example, the slides may fade-in/fade-out, rotate, get bigger or smaller, etc.
- [`carousel-snap-highlights`](techniques/carousel-snap-highlights.md) — Visually highlight the currently snapped non-interactive item in scroll-snapping carousels, galleries, or full-page swipe experiences. For example, expanding a card when snapped, or revealing hidden content.
- [`child-state-based-styling`](techniques/child-state-based-styling.md) — Build a component that changes its styling based on the state of one of its child elements. For example, a component that renders in light or dark mode based on whether a theme toggle is checked (or not).
- [`complex-shapes`](techniques/complex-shapes.md) — Clip elements and their content to any free-form shape, like a symbol, brush stroke, or organic texture for more expressive designs.
- [`component-specific-light-dark-theme`](techniques/component-specific-light-dark-theme.md) — Force certain elements to be in light mode or dark mode (e.g. code blocks, media players, etc) independently of the page's color-scheme.
- [`consistent-cross-document-transitions`](techniques/consistent-cross-document-transitions.md) — Ensure critical page state is loaded and stable before initiating a cross-document view transition. This means critical CSS styles are loaded and applied, critical JavaScript is loaded and run, and the HTML visible for the user's initial view of the page has been parsed before the transition runs.
- [`content-based-styling`](techniques/content-based-styling.md) — Build a component that changes its layout based on whether it contains specific child elements (or not). For example, if the component contains an image, use a multi-column layout, otherwise default to a single-column layout.
- [`coordinate-global-events`](techniques/coordinate-global-events.md) — Schedule future meetings or events by explicitly binding them to a geographical IANA time zone so that event times remain accurate regardless of Daylight Saving Time (DST) transitions, \
- [`cross-document-transitions`](techniques/cross-document-transitions.md) — Create smooth, seamless transitions between full page navigations, such as cross-fades, custom reveal effects, or morphing of content from one page to the next.
- [`customize-scrollbar-color-and-thickness`](techniques/customize-scrollbar-color-and-thickness.md) — Customize the color or thickness of a scrollbar
- [`dark-mode`](techniques/dark-mode.md) — Implement dark mode support in a way that respects the user's light/dark theme preference and adapts browser UI (e.g. scrollbars, form controls, etc)
- [`declarative-button-actions`](techniques/declarative-button-actions.md) — Declaratively connect a button to any element to trigger custom, application-specific actions using declarative button commands, invoker commands, button commands, custom commands, or declarative toggle actions.
- [`declarative-dialog-popover-control`](techniques/declarative-dialog-popover-control.md) — Toggle the visibility of a dialog or popover from a button without writing JavaScript.
- [`deliver-optimized-decorative-images`](techniques/deliver-optimized-decorative-images.md) — Deliver optimized decorative images (such as backgrounds, UI icons, or complex masks) by simultaneously providing next-generation image formats (like AVIF or WebP) alongside multiple pixel densities (like 1x and 2x) so the browser can dynamically negotiate the best combination of file size and visual quality for the user's device capabilities.
- [`design-token-reactivity`](techniques/design-token-reactivity.md) — Define higher-order design tokens, like density modes (compact, comfortable, spacious) or themes and have descendant components react to changes directly and in component-appropriate ways.
- [`directional-navigation-transitions`](techniques/directional-navigation-transitions.md) — Animate visual state changes to reflect the direction of a user's navigational flow, such as sliding new content in from the right when advancing forward or from the left when returning to a previous screen.
- [`dynamic-sibling-animations`](techniques/dynamic-sibling-animations.md) — Stagger animation or transition timing across sibling elements so each one starts after a computed delay based on its position in the sibling list.
- [`dynamic-sibling-styling`](techniques/dynamic-sibling-styling.md) — Create dynamic visual spectrums or layout arrangements that automatically adapt to the number of elements in a group.
- [`export-html-media-from-canvas`](techniques/export-html-media-from-canvas.md) — Capture and export dynamic HTML content as images or video frames from within canvas.
- [`expose-canvas-content-to-browser-features`](techniques/expose-canvas-content-to-browser-features.md) — Expose content rendered in a canvas to browser features like assistive technologies, translation, or reading mode.
- [`flicker-free-client-side-ab-testing`](techniques/flicker-free-client-side-ab-testing.md) — Deliver and render A/B tests, multi-variate tests, or other experiments using client-side JavaScript to alter or inject HTML, CSS, and JavaScript without the original content showing first before flickering or flashing to show the experiment content.
- [`fluid-scaling`](techniques/fluid-scaling.md) — Scale items like font size, spacing, and media sizes smoothly based on the parent container's size rather than using fixed breakpoints
- [`format-human-readable-durations`](techniques/format-human-readable-durations.md) — Present elapsed time or durations to users in a readable, localized format, with the flexibility to display either detailed unit breakdowns (e.g., \
- [`group-element-transitions`](techniques/group-element-transitions.md) — Transition a group of similar elements simultaneously using the same transition logic, such as removing a product from a shopping cart and having all the other products animate into their new positions.
- [`improve-text-layout-and-legibility`](techniques/improve-text-layout-and-legibility.md) — Improve the layout and legibility of short standalone text content, such as headings no longer than a few lines, by enabling the browser to apply evenly balanced line breaks when wrapping text.
- [`individual-transform-properties`](techniques/individual-transform-properties.md) — Animate or override individual CSS transform properties (e.g. translate, rotate, scale) independently of other transform properties on a single element.
- [`interactive-content-in-3d-scenes`](techniques/interactive-content-in-3d-scenes.md) — Integrate interactive HTML elements into a 3D scene.
- [`interactive-content-reveal`](techniques/interactive-content-reveal.md) — Create interactive reveal effects, such as a spotlight that follows the user's pointer to uncover details within an image or UI section.
- [`interest-triggered-action-previews`](techniques/interest-triggered-action-previews.md) — Show a live preview of a button's effect when a user signals interest (e.g. hovering, focusing, or long-pressing) but before they commit to clicking.
- [`interest-triggered-tooltips`](techniques/interest-triggered-tooltips.md) — Show a tooltip or supplemental information when a user hovers over, focuses on, or long-presses an interactive element, without requiring a click.
- [`light-dismiss-a-dialog`](techniques/light-dismiss-a-dialog.md) — Create a modal dialog that can be closed via light dismiss (i.e. clicking or tapping outside of the dialog)
- [`manage-recurring-intervals`](techniques/manage-recurring-intervals.md) — Calculate recurring intervals for subscription billings or payroll cycles, automatically adjusting for edge cases such as month-end transitions (e.g., adding one month to January 31st) to ensure accurate period calculations.
- [`model-partial-time-concepts`](techniques/model-partial-time-concepts.md) — Model date and time concepts that inherently lack a standard component (such as a specific year, day, or date) without using arbitrary placeholder values that introduce calculation errors.
- [`move-dom-element-without-losing-state`](techniques/move-dom-element-without-losing-state.md) — Move or reparent a DOM element without losing important element state, such as interactivity states (:focus/:active), <iframe> loading state, animation/transition state, etc
- [`navigation-drawer`](techniques/navigation-drawer.md) — Create a navigation drawer component that, when triggered from a menu button, slides in from the side overlayed on top of existing page content, and slides out when dismissed (by swiping away, tapping outside, or pressing escape).
- [`overflow-clipping-control`](techniques/overflow-clipping-control.md) — Adjust the visible clipping boundary of an element to align with the content edge, padding edge, or border edge—or a specified offset from any of these—offering finer-grained control over how content is clipped.
- [`parallax-scroll-effects`](techniques/parallax-scroll-effects.md) — Create scroll-based effects (such as parallax) where foreground and background layers move at different rates, creating a sense of depth as the user scrolls.
- [`persistent-app-tours`](techniques/persistent-app-tours.md) — Create persistent onboarding walkthroughs using tethered native overlays that stay open during user interaction.
- [`persistent-toast-notifications`](techniques/persistent-toast-notifications.md) — Create non-intrusive toast and overlay notifications for persistent, stackable messaging and state communication.
- [`persistent-top-layer-ui`](techniques/persistent-top-layer-ui.md) — Keep a modal dialog, fullscreen element, or native popover visibly open and functionally active when its underlying DOM node is moved or reparented in the DOM.
- [`physics-based-easing`](techniques/physics-based-easing.md) — Create custom, physics-based animation and transition effects, like bounce and spring, that feel more natural and engaging than traditional easing curves.
- [`platform-controls-dismiss-dialog`](techniques/platform-controls-dismiss-dialog.md) — Create a modal dialog that can be closed via standard platform-specific user actions, such as pressing the `Esc` key on desktop platforms, or a \
- [`position-aware-tooltips`](techniques/position-aware-tooltips.md) — Build tooltips and popovers with directional arrows (or other visual styling) that automatically point the correct way when the element flips to a fallback position.
- [`precise-text-alignment`](techniques/precise-text-alignment.md) — Achieve precise vertical alignment with text of any font. For example, exactly equal visual padding above and below text, or aligning text perfectly flush with adjacent icons or images.
- [`prevent-text-wrapping`](techniques/prevent-text-wrapping.md) — Ensure the browser does not insert line breaks into text and will allow text to overflow its container.
- [`pull-to-reveal`](techniques/pull-to-reveal.md) — Build a pull-to-reveal feature that would enable the user to pull down on the screen to reveal more content, like a search bar.
- [`reduce-style-repetition`](techniques/reduce-style-repetition.md) — Reduce excessive style repetition by encapsulating complex or dynamic styling logic into reusable functions (such as a function that computes a gradient based on a set of input parameters).
- [`resilient-context-menus-and-nested-dropdowns`](techniques/resilient-context-menus-and-nested-dropdowns.md) — Build accessible, responsive menus, tooltips, dropdowns, or contextual overlays that must be tethered to specific UI elements, guaranteeing that the overlay automatically repositions itself (e.g., flipping axes) when it encounters viewport edges, ensuring it never gets cut off.
- [`same-document-transitions`](techniques/same-document-transitions.md) — Visually connect persisting elements across different page states or navigations in a Single Page Application (SPA) (e.g. expanding a product thumbnail into a full-bleed hero image) by smoothly morphing their size, position, or other styling properties.
- [`scroll-entry-exit-effects`](techniques/scroll-entry-exit-effects.md) — Create fade-in, scale-up, or other complex reveal-type effects on elements as they enter and exit the scrollport (or viewport) while the user is scrolling.
- [`scroll-position-aware-elements`](techniques/scroll-position-aware-elements.md) — Build floating buttons or widgets (back-to-top, scroll-to-bottom, chat launchers, etc.) that appear and disappear based on whether the user has scrolled at all.
- [`scroll-progress-indicator`](techniques/scroll-progress-indicator.md) — Create a scroll progress bar, stepped progress tracker, or any visual affordance that communicates how far through a page or section the user has scrolled.
- [`scroll-snap-realtime-feedback`](techniques/scroll-snap-realtime-feedback.md) — Provide real-time visual feedback in linked UI elements while a user scrolls through snap-aligned content, before the scroll gesture completes.
- [`scroll-snap-state-sync`](techniques/scroll-snap-state-sync.md) — Synchronize navigation indicators, linked content panels, and analytics tracking with the actively snapped item in a scrollable container.
- [`scroll-target-on-load`](techniques/scroll-target-on-load.md) — Build a scrollable list of elements (e.g. a carousel of images or a chat conversation thread) that can be displayed with a particular element scrolled into view on the initial render.
- [`scrollability-affordance-hints`](techniques/scrollability-affordance-hints.md) — Build scroll-shadow overlays, gradient fades, or directional arrow indicators that appear only when there's actually more content to scroll to in that direction.
- [`scrollytelling`](techniques/scrollytelling.md) — Animate visual properties on a target element — such as fading a backdrop, shifting a background color, or to create scrollytelling experiences — driven entirely by the scrollport position of a completely different element.
- [`search-hidden-content`](techniques/search-hidden-content.md) — Hide content from view using patterns such as accordions, tabs, and \
- [`shaped-cutouts`](techniques/shaped-cutouts.md) — Combine multiple shapes to create complex cutouts or 'knockout' effects in elements, such as adding a notch to an element.
- [`shrinking-header-on-scroll`](techniques/shrinking-header-on-scroll.md) — Smoothly animate a fixed header or full-page cover on scroll to dynamically shrink, gain shadows, and transform its layout over a predefined scroll distance.
- [`size-aware-styling`](techniques/size-aware-styling.md) — Build a component whose styles can be conditionally dependent on its own width or height, rather than the width or height of the viewport. For example a card component that can change its layouts depending on how large it is, or a call-to-action button that can conditionally display helper text based on its width.
- [`soft-edge-content-fade`](techniques/soft-edge-content-fade.md) — Apply a transparency gradient to content edges to indicate further scrollable areas or to obscure payment-walled text.
- [`stabilize-reactive-state`](techniques/stabilize-reactive-state.md) — Manage task deadlines or schedules in data-driven views without unexpected side effects from shared mutable state.
- [`stack-drill-down`](techniques/stack-drill-down.md) — Build full-screen hierarchical navigation that lets users drill down into nested views and swipe or navigate back to return, with browser history kept in sync.
- [`style-parent-with-has`](techniques/style-parent-with-has.md) — Style parent elements of a form field (e.g. labels or fieldsets) when the field is invalid.
- [`support-global-calendar-systems`](techniques/support-global-calendar-systems.md) — Display and calculate dates in non-Gregorian calendar systems (e.g., Islamic, Hebrew, or Chinese) accurately for international users.
- [`swipe-to-remove`](techniques/swipe-to-remove.md) — Let users act on items in a list (remove, archive, mark as read, etc.) with a horizontal swipe gesture, so they can process entries quickly without tapping a separate control.
- [`visually-stable-font-fallbacks`](techniques/visually-stable-font-fallbacks.md) — Define font styles such that text remains readable and visually consistent in the event that there's a swap between the perferred font and one of the fallbacks (or vise versa).
- [`visually-stable-mixed-fonts`](techniques/visually-stable-mixed-fonts.md) — Define font styles such that text remains readable and visually consistent in situations where multiple fonts are used to render a single block of text.
- [`visually-texture-content`](techniques/visually-texture-content.md) — Apply realistic weathering and texture patterns to elements to give them an organic, aged, or physical material appearance.

### Forms & autofill

- [`animated-select-picker`](techniques/animated-select-picker.md) — Create a custom select component whose dropdown is animated. For example, the menu fades or slides into view, or the options animate upon selection.
- [`autofill-address-form`](techniques/autofill-address-form.md) — Build an address form with correct autocomplete attributes and autofill support.
- [`autofill-highlight-inputs`](techniques/autofill-highlight-inputs.md) — Use CSS to highlight form fields that have been autofilled by the browser and not edited by the user.
- [`autofill-payment-form`](techniques/autofill-payment-form.md) — Build a payment form that collects card details with correct autocomplete values and autofill support.
- [`autofill-sign-in-form`](techniques/autofill-sign-in-form.md) — Build a sign-in form with correct autocomplete values and autofill support.
- [`autofill-sign-up-form`](techniques/autofill-sign-up-form.md) — Build a sign-up form with correct autocomplete values and autofill support.
- [`brand-consistent-forms`](techniques/brand-consistent-forms.md) — Match checkboxes, radio buttons, range sliders, and progress bars to your site's color palette without replacing them with custom components.
- [`branded-select-styling`](techniques/branded-select-styling.md) — Create custom select elements whose button, picker, arrow icon, and checkmark all seamlessly match your brand or design system's typography, colors, spacing, and border treatments.
- [`custom-select-picker-layouts`](techniques/custom-select-picker-layouts.md) — Create custom select pickers whose options are positioned in unique or interesting ways, rather than the traditional stacked list of options.
- [`form-fields-automatically-fit-contents`](techniques/form-fields-automatically-fit-contents.md) — Allow form fields to grow and shrink to fit the user input, e.g. as the user types or selects a different option. Apply maximum and minimum size limits to create dynamic and responsive form fields that conform with the page design.
- [`forms`](techniques/forms.md) — Best practices for building accessible, secure, and user-friendly web forms. Use this guide when creating or modifying forms, inputs, and submission flows.
- [`required-field-feedback`](techniques/required-field-feedback.md) — Provide error message for required form fields that were skipped or left empty *only* after user interaction, to avoid preemptive errors and ensure feedback is timely and contextually relevant to the user's flow.
- [`rich-media-picker`](techniques/rich-media-picker.md) — Create a custom select component whose options can contain complex HTML formatting (e.g. images, icons, and other rich formatting) rather than just plain text.
- [`select-menu-interaction`](techniques/select-menu-interaction.md) — Validate that a non-default option has been chosen in a select menu only after the user has interacted with the control.
- [`validate-input-after-interaction`](techniques/validate-input-after-interaction.md) — Show form field validation feedback (e.g. password complexity or email format requirements) only after the user has finished their initial interaction, avoiding premature errors on page load or while the user is typing.

### Passkeys & WebAuthn

- [`passkey-authentication`](techniques/passkey-authentication.md) — Authenticate a returning user with a passkey for primary sign-in.
- [`passkey-conditional-create`](techniques/passkey-conditional-create.md) — Silently register a passkey for an existing user after a successful password login.
- [`passkey-management`](techniques/passkey-management.md) — Let users view and manage the passkeys registered to their account.
- [`passkey-reauthentication`](techniques/passkey-reauthentication.md) — Verify a signed-in user's identity using their existing passkeys before a sensitive action.
- [`passkey-registration`](techniques/passkey-registration.md) — Register a passkey for an existing user account.
- [`passkeys`](techniques/passkeys.md) — Comprehensive orientation and cross-cutting principles for implementing WebAuthn and Passkeys in web applications. Use this guide when handling passkey registration, authentication, management, or reauthentication.

### Accessibility

- [`accessibility`](techniques/accessibility.md) — Actionable coding guidelines for building accessible web applications, covering semantic HTML, focus management, forms, media, and testing. Use this skill when auditing or implementing accessibility features, keyboard navigation, or ARIA.
- [`accessible-error-announcement`](techniques/accessible-error-announcement.md) — Synchronize programmatic accessibility states (like aria-invalid) with the visual :user-invalid state to ensure screen reader users receive error feedback only after interaction, mirroring the visual experience.

### Performance & Core Web Vitals

- [`batch-analytics-events`](techniques/batch-analytics-events.md) — Debounce and batch multiple analytics events together in a single beacon to minimize network contention and reduce server load, while still delivering real-time updates.
- [`break-up-long-tasks`](techniques/break-up-long-tasks.md) — Break up heavy synchronous processing (complex computations and/or long loops) or DOM updates, to let the browser handle user input and repaint the screen.
- [`calculate-total-foreground-time`](techniques/calculate-total-foreground-time.md) — Calculate the total time a user actually spent viewing a page, excluding periods when the tab was in the background.
- [`conditional-async-dependencies`](techniques/conditional-async-dependencies.md) — Conditionally load or initialize async dependencies (such as importing polyfills for missing web features) without requiring complex orchestration across all of a page's script dependencies.
- [`defer-rendering-heavy-content`](techniques/defer-rendering-heavy-content.md) — Reduce rendering times in content-heavy web pages (e.g. pages with long feeds, lots of articles, or complex dashboards), by deferring rendering for any content that is not immediately visible to the user.
- [`defer-work-until-scroll-ends`](techniques/defer-work-until-scroll-ends.md) — Defer expensive operations like DOM updates, data fetching, analytics tracking, or layout recalculation until after scrolling completes to maintain smooth scroll performance.
- [`deprioritize-background-fetches`](techniques/deprioritize-background-fetches.md) — Deprioritize background data fetches made with the Fetch API to prevent network contention with user-initiated requests.
- [`detect-initial-visibility-state`](techniques/detect-initial-visibility-state.md) — Reliably determine whether a page was initially loaded in the background, even in cases where the script is loaded asynchronously after the user foregrounded the page.
- [`efficient-background-processing`](techniques/efficient-background-processing.md) — Conserve system resources and battery life by pausing background JavaScript execution (such as <canvas> animations, WebGL rendering, or high-frequency WebSocket data polling) when the component is off-screen and then resume them just-in-time when they scroll back into view.
- [`faster-spa-view-transitions`](techniques/faster-spa-view-transitions.md) — Enable faster transitions back to previously visited views in a Single-Page Application (SPA) by preserving their structural DOM state instead of destroying and rebuilding them on every navigation.
- [`full-session-analytics`](techniques/full-session-analytics.md) — Reliably track analytics, errors, and telemetry data across the user's entire page visit, and defer sending of the data until the user leaves the page.
- [`identify-heavy-scripts`](techniques/identify-heavy-scripts.md) — Identify the scripts most responsible for long animation frames
- [`identify-inp-causes`](techniques/identify-inp-causes.md) — Identify slow running JavaScript that is impacting INP metric
- [`improve-next-page-load-performance`](techniques/improve-next-page-load-performance.md) — Improve page load performance by prefetching or prerendering pages that the user is likely to visit next.
- [`interactions-in-complex-layouts`](techniques/interactions-in-complex-layouts.md) — Make interactions snappier and more responsive (reducing Interaction to Next Paint (INP) scores) by avoiding layout re-calculations in complex layouts, such as data-heavy dashboards or spreadsheet-style grids.
- [`optimize-image-priority`](techniques/optimize-image-priority.md) — Optimize the loading priority of Largest Contentful Paint (LCP) candidate images and deprioritize non-critical images to reduce critical resource load delays.
- [`optimize-preload-priority`](techniques/optimize-preload-priority.md) — Optimize the relative priority of preloaded content to reduce critical resource load delays.
- [`optimize-script-priority`](techniques/optimize-script-priority.md) — Optimize the loading priority of scripts by boosting critical asynchronous scripts and deprioritizing non-essential or late-body scripts to improve sequencing and reduce delays.
- [`performance`](techniques/performance.md) — Actionable guidelines for optimizing modern web applications. Use this guide when auditing performance, optimizing loading metrics, fixing slow interactions and optimizing Core Web Vitals (LCP, INP, CLS)
- [`resolution-optimized-pseudo-elements`](techniques/resolution-optimized-pseudo-elements.md) — Use resolution-optimized images in CSS pseudo-elements (such as `::before` and `::after`) to reduce the number of DOM nodes.
- [`schedule-tasks-by-priority`](techniques/schedule-tasks-by-priority.md) — Schedule tasks with different priorities to ensure critical work runs first while background work is deferred.
- [`sequence-distributed-events`](techniques/sequence-distributed-events.md) — Log and sequence operations in distributed microservices or high-throughput tracing environments by recording timestamps with nanosecond resolution.

### Security

- [`security`](techniques/security.md) — Preventative security guidelines for web developers (XSS, CSP, Cookies, Cross-Origin Isolation). Use this skill to guide the process of auditing, testing, and deploying security policies safely.

### Privacy

- [`privacy`](techniques/privacy.md) — Action-oriented guidelines for web developers to implement privacy by design, data minimization, third-party audits, and secure data handling. Use this skill when designing applications, integrating third-party services, handling user data, or configuring security headers.

### Built-in browser AI

- [`language-detection`](techniques/language-detection.md) — Detect the language of user-generated content or already present site content.
- [`language-model`](techniques/language-model.md) — Run on-device natural language inference in the browser using the Prompt API, with streaming output, structured JSON responses, and multi-turn session management.
- [`summarizer`](techniques/summarizer.md) — Summarize text content using the on-device Summarizer API.
- [`translator`](techniques/translator.md) — Translate text between languages using the on-device Translator API.

### WebMCP (agent-facing web)

- [`agentic-forms`](techniques/agentic-forms.md) — Expose client-side functionality as tools to AI agents by annotating standard HTML forms with WebMCP attributes.
- [`agentic-javascript-tools`](techniques/agentic-javascript-tools.md) — Programmatically register client-side JavaScript functions as tools for AI agents using the WebMCP Imperative API.
