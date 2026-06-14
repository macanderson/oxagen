/* @ds-bundle: {"format":3,"namespace":"OxagenDesignSystem_2dfe15","components":[{"name":"ConfidenceBar","sourcePath":"components/brand/ConfidenceBar.jsx"},{"name":"NodeChip","sourcePath":"components/brand/NodeChip.jsx"},{"name":"OxagenLogo","sourcePath":"components/brand/OxagenLogo.jsx"},{"name":"CopyButton","sourcePath":"components/code/CodeBlock.jsx"},{"name":"CodeBlock","sourcePath":"components/code/CodeBlock.jsx"},{"name":"CodeTabs","sourcePath":"components/code/CodeTabs.jsx"},{"name":"LangIcon","sourcePath":"components/code/LangIcon.jsx"},{"name":"Avatar","sourcePath":"components/core/Avatar.jsx"},{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Card","sourcePath":"components/core/Card.jsx"},{"name":"CardHeader","sourcePath":"components/core/Card.jsx"},{"name":"CardTitle","sourcePath":"components/core/Card.jsx"},{"name":"CardDescription","sourcePath":"components/core/Card.jsx"},{"name":"CardBody","sourcePath":"components/core/Card.jsx"},{"name":"CardFooter","sourcePath":"components/core/Card.jsx"},{"name":"Input","sourcePath":"components/core/Input.jsx"},{"name":"Switch","sourcePath":"components/core/Switch.jsx"},{"name":"Tabs","sourcePath":"components/core/Tabs.jsx"},{"name":"Textarea","sourcePath":"components/core/Textarea.jsx"},{"name":"Dialog","sourcePath":"components/feedback/Dialog.jsx"},{"name":"Drawer","sourcePath":"components/feedback/Drawer.jsx"},{"name":"ToastProvider","sourcePath":"components/feedback/ToastProvider.jsx"},{"name":"OnboardingWizard","sourcePath":"components/flows/OnboardingWizard.jsx"},{"name":"Stepper","sourcePath":"components/flows/Stepper.jsx"},{"name":"Collapse","sourcePath":"components/layout/Collapse.jsx"},{"name":"MainNav","sourcePath":"components/layout/MainNav.jsx"},{"name":"Panel","sourcePath":"components/layout/Panel.jsx"},{"name":"Sidebar","sourcePath":"components/layout/Sidebar.jsx"},{"name":"AnimatePresence","sourcePath":"components/lib/motion.js"},{"name":"MotionConfig","sourcePath":"components/lib/motion.js"},{"name":"SPRING","sourcePath":"components/lib/motion.js"},{"name":"BOUNCE","sourcePath":"components/lib/motion.js"},{"name":"EASE_ENTRY","sourcePath":"components/lib/motion.js"},{"name":"EASE_EXIT","sourcePath":"components/lib/motion.js"}],"sourceHashes":{"components/brand/ConfidenceBar.jsx":"bdb92d513032","components/brand/NodeChip.jsx":"427d197af531","components/brand/OxagenLogo.jsx":"80ce1b66ea45","components/code/CodeBlock.jsx":"0bad027db329","components/code/CodeTabs.jsx":"9ecfc3358101","components/code/LangIcon.jsx":"99a93533f72f","components/code/highlight.js":"9e8320642e84","components/core/Avatar.jsx":"2e49e29e1928","components/core/Badge.jsx":"c131c794182b","components/core/Button.jsx":"c2970d9cb7aa","components/core/Card.jsx":"50671bf5f61e","components/core/Input.jsx":"fde156acb810","components/core/Switch.jsx":"cb2a7ea08771","components/core/Tabs.jsx":"b36dd74a38d6","components/core/Textarea.jsx":"9fab3a4791c8","components/feedback/Dialog.jsx":"8c913002ab9c","components/feedback/Drawer.jsx":"d90038fe2595","components/feedback/ToastProvider.jsx":"96969106a711","components/flows/OnboardingWizard.jsx":"8c634f960ce9","components/flows/Stepper.jsx":"c08c19199806","components/layout/Collapse.jsx":"c05f3c6d4e2f","components/layout/MainNav.jsx":"254b0d8f2593","components/layout/Panel.jsx":"bc4bba5e848e","components/layout/Sidebar.jsx":"c67d88701bf7","components/lib/motion.js":"3699c951b059","ui_kits/app/AccessScreen.jsx":"1152c4208e84","ui_kits/app/App.jsx":"eec6e5448858","ui_kits/app/AskScreen.jsx":"1ce98cd2458f","ui_kits/app/KnowledgeScreen.jsx":"fa72cc64651c","ui_kits/app/LoginScreen.jsx":"427da64c1c8c","ui_kits/app/Shell.jsx":"d24f109e123a","ui_kits/app/icons.jsx":"c2b781bb6d38"},"inlinedExternals":[],"unexposedExports":[{"name":"hasMotion","sourcePath":"components/lib/motion.js"},{"name":"highlight","sourcePath":"components/code/highlight.js"},{"name":"m","sourcePath":"components/lib/motion.js"},{"name":"useToast","sourcePath":"components/feedback/ToastProvider.jsx"}]} */

(() => {

const __ds_ns = (window.OxagenDesignSystem_2dfe15 = window.OxagenDesignSystem_2dfe15 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/brand/ConfidenceBar.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * ConfidenceBar — inference confidence meter for semantic edges. Colour follows
 * the product thresholds: ≥0.8 success, ≥0.6 warning, else danger.
 */
function band(score) {
  if (score >= 0.8) return ["#37a04d", "#67d182"];
  if (score >= 0.6) return ["var(--warning)", "#ffbe63"];
  return ["var(--destructive)", "#ff8a6b"];
}
function ConfidenceBar({
  score = 0,
  showValue = true,
  width = 120,
  style,
  ...props
}) {
  const s = Math.max(0, Math.min(1, score));
  const [track, text] = band(s);
  return /*#__PURE__*/React.createElement("span", _extends({
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 8,
      ...style
    }
  }, props), /*#__PURE__*/React.createElement("span", {
    style: {
      position: "relative",
      width,
      height: 6,
      borderRadius: 999,
      background: "var(--muted)",
      overflow: "hidden",
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      position: "absolute",
      inset: 0,
      width: `${s * 100}%`,
      background: track,
      borderRadius: 999,
      boxShadow: `0 0 8px ${track}`
    }
  })), showValue && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: 11,
      fontWeight: 600,
      color: text,
      fontVariantNumeric: "tabular-nums"
    }
  }, Math.round(s * 100), "%"));
}
Object.assign(__ds_scope, { ConfidenceBar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/brand/ConfidenceBar.jsx", error: String((e && e.message) || e) }); }

// components/brand/NodeChip.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * NodeChip — a knowledge-graph node reference. A typed dot + mono node id,
 * the way the product renders entities in edge diagrams and tool output.
 * `kind` colours the dot by entity class.
 */
const KIND_COLOR = {
  user: "var(--cyan-400)",
  document: "var(--violet-400)",
  service: "#67d182",
  policy: "var(--cosmos-400)",
  resource: "var(--warning)",
  default: "var(--muted-foreground)"
};
function NodeChip({
  kind = "default",
  id,
  label,
  style,
  ...props
}) {
  const color = KIND_COLOR[kind] || KIND_COLOR.default;
  return /*#__PURE__*/React.createElement("span", _extends({
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      padding: "3px 9px 3px 8px",
      background: "var(--background-2)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-full)",
      fontFamily: "var(--font-mono)",
      fontSize: 11,
      color: "var(--foreground)",
      whiteSpace: "nowrap",
      ...style
    }
  }, props), /*#__PURE__*/React.createElement("span", {
    style: {
      width: 7,
      height: 7,
      borderRadius: "50%",
      background: color,
      flexShrink: 0,
      boxShadow: `0 0 6px ${color}`
    }
  }), label && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-sans)",
      fontWeight: 500
    }
  }, label), id && /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted-foreground)",
      letterSpacing: "0.02em"
    }
  }, id));
}
Object.assign(__ds_scope, { NodeChip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/brand/NodeChip.jsx", error: String((e && e.message) || e) }); }

// components/brand/OxagenLogo.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Oxagen logo system.
 *
 * MARK: a simple thick circle outline (the "O") stroked in the nebula gradient
 * (cyan→violet→cosmos). WORDMARK: "Oxagen" in Aeonik Fono (the only place Fono
 * is used). Lockups combine them horizontally or vertically.
 *
 *   variant: "mark" | "wordmark" | "horizontal" | "vertical"
 *   tone:    "gradient"  — nebula ring + currentColor wordmark (full color)
 *            "mono-light"— everything #F4F6FB (for dark backgrounds)
 *            "mono-dark" — everything #0F0E15 (for light backgrounds)
 *            "solid"     — everything currentColor
 *   size = mark height in px.
 */
const NEBULA = ["#7ce8f4", "#7c5aed", "#df2a5d"];
function monoColor(tone) {
  if (tone === "mono-light") return "#f4f6fb";
  if (tone === "mono-dark") return "#0f0e15";
  if (tone === "solid") return "currentColor";
  return null; // gradient
}
function Ring({
  size,
  tone
}) {
  const id = React.useId().replace(/:/g, "");
  const mono = monoColor(tone);
  const stroke = mono || `url(#oxneb-${id})`;
  return /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 100 100",
    fill: "none",
    "aria-label": "Oxagen",
    style: {
      display: "block",
      flexShrink: 0
    }
  }, !mono && /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("linearGradient", {
    id: `oxneb-${id}`,
    x1: "10",
    y1: "10",
    x2: "90",
    y2: "90",
    gradientUnits: "userSpaceOnUse"
  }, /*#__PURE__*/React.createElement("stop", {
    offset: "0",
    stopColor: NEBULA[0]
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "0.52",
    stopColor: NEBULA[1]
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "1",
    stopColor: NEBULA[2]
  }))), /*#__PURE__*/React.createElement("circle", {
    cx: "50",
    cy: "50",
    r: "37",
    stroke: stroke,
    strokeWidth: "13"
  }));
}
function Wordmark({
  size,
  tone,
  style
}) {
  const mono = monoColor(tone);
  return /*#__PURE__*/React.createElement("span", {
    className: "ox-wordmark",
    style: {
      fontFamily: "var(--font-display)",
      fontWeight: 500,
      letterSpacing: "-0.04em",
      fontSize: size,
      lineHeight: 1,
      color: mono || "currentColor",
      ...style
    }
  }, "Oxagen");
}
function OxagenLogo({
  variant = "horizontal",
  tone = "gradient",
  size = 28,
  style,
  className,
  ...props
}) {
  if (variant === "mark") {
    return /*#__PURE__*/React.createElement("span", _extends({
      className: className,
      style: {
        display: "inline-flex",
        ...style
      }
    }, props), /*#__PURE__*/React.createElement(Ring, {
      size: size,
      tone: tone
    }));
  }
  if (variant === "wordmark") {
    return /*#__PURE__*/React.createElement("span", _extends({
      className: className,
      style: {
        display: "inline-flex",
        ...style
      }
    }, props), /*#__PURE__*/React.createElement(Wordmark, {
      size: size,
      tone: tone
    }));
  }
  if (variant === "vertical") {
    return /*#__PURE__*/React.createElement("span", _extends({
      className: className,
      style: {
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "center",
        gap: size * 0.34,
        ...style
      }
    }, props), /*#__PURE__*/React.createElement(Ring, {
      size: size,
      tone: tone
    }), /*#__PURE__*/React.createElement(Wordmark, {
      size: size * 0.92,
      tone: tone
    }));
  }
  // horizontal (default)
  return /*#__PURE__*/React.createElement("span", _extends({
    className: className,
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: size * 0.42,
      ...style
    }
  }, props), /*#__PURE__*/React.createElement(Ring, {
    size: size,
    tone: tone
  }), /*#__PURE__*/React.createElement(Wordmark, {
    size: size * 1.02,
    tone: tone
  }));
}
Object.assign(__ds_scope, { OxagenLogo });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/brand/OxagenLogo.jsx", error: String((e && e.message) || e) }); }

// components/code/LangIcon.jsx
try { (() => {
/**
 * LangIcon — a small, dependency-free language glyph badge (e.g. TS, PY, GO).
 * Used by CodeTabs to label tabs with language-specific marks. Pass `language`
 * (a key below) or a custom `node`.
 */
const LANGS = {
  ts: {
    label: "TS",
    bg: "#3178c6",
    fg: "#fff"
  },
  tsx: {
    label: "TSX",
    bg: "#3178c6",
    fg: "#fff"
  },
  js: {
    label: "JS",
    bg: "#f7df1e",
    fg: "#1b1924"
  },
  jsx: {
    label: "JSX",
    bg: "#f7df1e",
    fg: "#1b1924"
  },
  py: {
    label: "PY",
    bg: "#3776ab",
    fg: "#fff"
  },
  python: {
    label: "PY",
    bg: "#3776ab",
    fg: "#fff"
  },
  go: {
    label: "GO",
    bg: "#00add8",
    fg: "#03242b"
  },
  rust: {
    label: "RS",
    bg: "#dea584",
    fg: "#2b1a10"
  },
  rs: {
    label: "RS",
    bg: "#dea584",
    fg: "#2b1a10"
  },
  bash: {
    label: "SH",
    bg: "#4eaa25",
    fg: "#04200a"
  },
  sh: {
    label: "SH",
    bg: "#4eaa25",
    fg: "#04200a"
  },
  shell: {
    label: "SH",
    bg: "#4eaa25",
    fg: "#04200a"
  },
  json: {
    label: "{ }",
    bg: "#5b5766",
    fg: "#fff"
  },
  sql: {
    label: "SQL",
    bg: "#e38c00",
    fg: "#231300"
  },
  cypher: {
    label: "CY",
    bg: "#7c5aed",
    fg: "#fff"
  },
  graphql: {
    label: "GQL",
    bg: "#e10098",
    fg: "#fff"
  },
  curl: {
    label: "cURL",
    bg: "#073551",
    fg: "#fff"
  },
  http: {
    label: "HTTP",
    bg: "#5b5766",
    fg: "#fff"
  }
};
function LangIcon({
  language,
  node,
  size = 18
}) {
  if (node) return /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      width: size,
      height: size
    }
  }, node);
  const l = LANGS[(language || "").toLowerCase()] || {
    label: (language || "·").slice(0, 3).toUpperCase(),
    bg: "var(--muted)",
    fg: "var(--muted-foreground)"
  };
  return /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      minWidth: size,
      height: size,
      padding: "0 4px",
      borderRadius: 4,
      background: l.bg,
      color: l.fg,
      fontFamily: "var(--font-mono)",
      fontSize: size * 0.46,
      fontWeight: 700,
      letterSpacing: "0.02em"
    }
  }, l.label);
}
Object.assign(__ds_scope, { LangIcon });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/code/LangIcon.jsx", error: String((e && e.message) || e) }); }

// components/code/highlight.js
try { (() => {
/*
 * highlight.js — tiny, dependency-free syntax tokenizer used by CodeBlock and
 * CodeTabs. Colours comments, strings, numbers and a broad keyword set in the
 * jewel palette. Not a full parser — intentionally small and language-agnostic.
 */

const COLORS = {
  comment: "var(--muted-foreground)",
  string: "var(--cyan-300)",
  number: "#f088a6",
  keyword: "var(--ox-violet-bright, #9b7bff)"
};

// Order matters: earlier patterns win at a given position.
const SPEC = [["comment", /\/\/[^\n]*|#[^\n]*|--[^\n]*|\/\*[\s\S]*?\*\//y], ["string", /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/y], ["number", /\b\d[\d_.]*(?:e[+-]?\d+)?\b/iy], ["keyword", /\b(?:const|let|var|function|func|fn|return|if|elif|else|for|while|do|switch|case|break|continue|import|from|export|default|class|extends|implements|interface|type|enum|new|delete|await|async|yield|try|catch|finally|throw|public|private|protected|static|readonly|def|lambda|pass|with|as|in|of|is|not|and|or|match|use|pub|impl|struct|trait|mod|where|select|insert|update|delete|create|merge|MATCH|RETURN|WHERE|CREATE|MERGE|WITH|true|false|null|nil|None|True|False|void|self|this)\b/y], ["ident", /[A-Za-z_$][\w$]*/y], ["ws", /\s+/y], ["any", /[\s\S]/y]];

/** Returns an array of strings / colored <span> React nodes for `code`. */
function highlight(code) {
  const out = [];
  let i = 0;
  let key = 0;
  while (i < code.length) {
    let matched = false;
    for (const [type, re] of SPEC) {
      re.lastIndex = i;
      const mm = re.exec(code);
      if (mm && mm.index === i && mm[0].length > 0) {
        const text = mm[0];
        const color = COLORS[type];
        if (color) out.push(React.createElement("span", {
          key: key++,
          style: {
            color
          }
        }, text));else out.push(text);
        i += text.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out.push(code[i]);
      i++;
    }
  }
  return out;
}
Object.assign(__ds_scope, { highlight });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/code/highlight.js", error: String((e && e.message) || e) }); }

// components/code/CodeBlock.jsx
try { (() => {
/** Shared copy-to-clipboard button with a "Copied" confirmation. */
function CopyButton({
  getText
}) {
  const [copied, setCopied] = React.useState(false);
  function copy() {
    const text = getText();
    try {
      navigator.clipboard?.writeText(text);
    } catch (e) {/* clipboard unavailable */}
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }
  return /*#__PURE__*/React.createElement("button", {
    onClick: copy,
    "aria-label": "Copy code",
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      height: 26,
      padding: "0 9px",
      borderRadius: "var(--radius-sm)",
      border: "1px solid var(--border)",
      background: "var(--background-2)",
      color: copied ? "#67d182" : "var(--muted-foreground)",
      fontFamily: "var(--font-sans)",
      fontSize: 11.5,
      fontWeight: 600,
      cursor: "pointer",
      transition: "color var(--motion-micro)"
    }
  }, copied ? /*#__PURE__*/React.createElement("svg", {
    width: "13",
    height: "13",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2.4",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "M20 6 9 17l-5-5"
  })) : /*#__PURE__*/React.createElement("svg", {
    width: "13",
    height: "13",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("rect", {
    x: "9",
    y: "9",
    width: "13",
    height: "13",
    rx: "2"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
  })), copied ? "Copied" : "Copy");
}
function CodeBody({
  code,
  showLineNumbers
}) {
  const lines = code.replace(/\n$/, "").split("\n");
  return /*#__PURE__*/React.createElement("pre", {
    style: {
      margin: 0,
      padding: "14px 16px",
      overflowX: "auto",
      fontFamily: "var(--font-mono)",
      fontSize: 12.5,
      lineHeight: 1.65
    }
  }, /*#__PURE__*/React.createElement("code", {
    style: {
      fontFamily: "inherit",
      display: "block"
    }
  }, showLineNumbers ? lines.map((ln, i) => /*#__PURE__*/React.createElement("span", {
    key: i,
    style: {
      display: "grid",
      gridTemplateColumns: "2ch 1fr",
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted-foreground)",
      opacity: 0.5,
      userSelect: "none",
      textAlign: "right"
    }
  }, i + 1), /*#__PURE__*/React.createElement("span", null, __ds_scope.highlight(ln), "\n"))) : __ds_scope.highlight(code)));
}

/**
 * Oxagen CodeBlock — a single source listing with a header (language glyph +
 * filename) and a copy button. Mono is used here because this IS source code.
 */
function CodeBlock({
  code = "",
  language = "ts",
  filename,
  showLineNumbers = false,
  copy = true,
  style
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-lg)",
      background: "var(--background-2)",
      overflow: "hidden",
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 9,
      padding: "8px 10px 8px 12px",
      borderBottom: "1px solid var(--border)",
      background: "var(--card)"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.LangIcon, {
    language: language
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 12,
      color: "var(--muted-foreground)"
    }
  }, filename || language), copy && /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: "auto"
    }
  }, /*#__PURE__*/React.createElement(CopyButton, {
    getText: () => code
  }))), /*#__PURE__*/React.createElement(CodeBody, {
    code: code,
    showLineNumbers: showLineNumbers
  }));
}
Object.assign(__ds_scope, { CopyButton, CodeBlock });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/code/CodeBlock.jsx", error: String((e && e.message) || e) }); }

// components/core/Avatar.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Oxagen Avatar. Renders an image, or initials on a deterministic jewel
 * gradient derived from the name. `gradient` forces the brand cosmos sweep.
 */
const GRADS = ["var(--grad-aurora)", "var(--grad-sunset)", "var(--grad-cosmos)", "var(--grad-nebula)"];
function hash(s = "") {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = h * 31 + s.charCodeAt(i) >>> 0;
  return h;
}
function Avatar({
  src,
  name = "",
  size = 32,
  gradient = false,
  style,
  ...props
}) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]?.toUpperCase()).join("");
  const bg = gradient ? "var(--grad-cosmos)" : GRADS[hash(name) % GRADS.length];
  return /*#__PURE__*/React.createElement("span", _extends({
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      width: size,
      height: size,
      borderRadius: "50%",
      overflow: "hidden",
      flexShrink: 0,
      background: src ? "var(--muted)" : bg,
      color: "#fff",
      fontFamily: "var(--font-sans)",
      fontWeight: 600,
      fontSize: Math.round(size * 0.4),
      border: "1px solid var(--border)",
      ...style
    }
  }, props), src ? /*#__PURE__*/React.createElement("img", {
    src: src,
    alt: name,
    style: {
      width: "100%",
      height: "100%",
      objectFit: "cover"
    }
  }) : initials || "?");
}
Object.assign(__ds_scope, { Avatar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Avatar.jsx", error: String((e && e.message) || e) }); }

// components/core/Badge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Oxagen Badge — compact status/label pill.
 * Variants cover neutral, brand, and the semantic + risk signals the product
 * uses heavily (low/medium/high risk on agent tool calls).
 */
function tones(variant) {
  const map = {
    default: ["color-mix(in oklch, var(--violet-500) 18%, transparent)", "var(--violet-bright, #9b7bff)", "color-mix(in oklch, var(--violet-500) 40%, transparent)"],
    neutral: ["var(--muted)", "var(--muted-foreground)", "var(--border)"],
    brand: ["color-mix(in oklch, var(--brand) 16%, transparent)", "var(--violet-bright, #9b7bff)", "color-mix(in oklch, var(--brand) 38%, transparent)"],
    cyan: ["color-mix(in oklch, var(--cyan-400) 16%, transparent)", "var(--cyan-300)", "color-mix(in oklch, var(--cyan-400) 40%, transparent)"],
    info: ["color-mix(in oklch, var(--info) 18%, transparent)", "#7fb4f0", "color-mix(in oklch, var(--info) 42%, transparent)"],
    success: ["color-mix(in oklch, var(--success) 20%, transparent)", "#67d182", "color-mix(in oklch, var(--success) 44%, transparent)"],
    warning: ["color-mix(in oklch, var(--warning) 22%, transparent)", "#ffbe63", "color-mix(in oklch, var(--warning) 46%, transparent)"],
    danger: ["color-mix(in oklch, var(--destructive) 20%, transparent)", "#ff8a6b", "color-mix(in oklch, var(--destructive) 46%, transparent)"],
    "risk-low": ["color-mix(in oklch, var(--success) 18%, transparent)", "#67d182", "color-mix(in oklch, var(--success) 40%, transparent)"],
    "risk-medium": ["color-mix(in oklch, var(--warning) 20%, transparent)", "#ffbe63", "color-mix(in oklch, var(--warning) 44%, transparent)"],
    "risk-high": ["color-mix(in oklch, var(--destructive) 20%, transparent)", "#ff8a6b", "color-mix(in oklch, var(--destructive) 46%, transparent)"]
  };
  return map[variant] || map.default;
}
function Badge({
  variant = "default",
  mono = false,
  dot = false,
  children,
  style,
  className,
  ...props
}) {
  const [bg, fg, bd] = tones(variant);
  return /*#__PURE__*/React.createElement("span", _extends({
    className: className,
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 5,
      padding: "2px 8px",
      fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: mono ? "0.04em" : "0",
      lineHeight: 1.4,
      color: fg,
      background: bg,
      border: `1px solid ${bd}`,
      borderRadius: "var(--radius-sm)",
      whiteSpace: "nowrap",
      ...style
    }
  }, props), dot && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: "50%",
      background: fg
    }
  }), children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Badge.jsx", error: String((e && e.message) || e) }); }

// components/core/Card.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Oxagen Card surface + parts. `glow` adds the violet focus ring for the
 * featured card on a surface; `gradientRing` wraps it in the nebula hairline.
 */
function Card({
  glow = false,
  gradientRing = false,
  interactive = false,
  style,
  className,
  children,
  ...props
}) {
  const [hover, setHover] = React.useState(false);
  return /*#__PURE__*/React.createElement("div", _extends({
    className: [gradientRing ? "ox-gradient-ring" : "", className].filter(Boolean).join(" "),
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      background: "var(--card)",
      color: "var(--card-foreground)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-lg)",
      boxShadow: glow ? "var(--glow-violet)" : interactive && hover ? "var(--shadow-lg)" : "var(--shadow-sm)",
      transform: interactive && hover ? "translateY(-2px)" : "none",
      transition: "transform var(--motion-base) var(--ease-hover), box-shadow var(--motion-base) var(--ease-hover)",
      ...style
    }
  }, props), children);
}
function CardHeader({
  style,
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      padding: "18px 20px 0",
      ...style
    }
  }, props), children);
}
function CardTitle({
  style,
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("h3", _extends({
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: 16,
      fontWeight: 600,
      letterSpacing: "-0.01em",
      margin: 0,
      ...style
    }
  }, props), children);
}
function CardDescription({
  style,
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("p", _extends({
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: 13,
      lineHeight: 1.5,
      color: "var(--muted-foreground)",
      margin: "4px 0 0",
      ...style
    }
  }, props), children);
}
function CardBody({
  style,
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      padding: 20,
      ...style
    }
  }, props), children);
}
function CardFooter({
  style,
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "0 20px 18px",
      ...style
    }
  }, props), children);
}
Object.assign(__ds_scope, { Card, CardHeader, CardTitle, CardDescription, CardBody, CardFooter });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Card.jsx", error: String((e && e.message) || e) }); }

// components/core/Input.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Oxagen text input. Dark-first; focus shows a jewel violet ring. */
function Input({
  size = "md",
  invalid = false,
  startIcon = null,
  style,
  className,
  ...props
}) {
  const h = size === "sm" ? 30 : size === "lg" ? 40 : 34;
  const [focused, setFocused] = React.useState(false);
  return /*#__PURE__*/React.createElement("span", {
    style: {
      position: "relative",
      display: "inline-flex",
      alignItems: "center",
      width: "100%"
    }
  }, startIcon && /*#__PURE__*/React.createElement("span", {
    style: {
      position: "absolute",
      left: 10,
      display: "inline-flex",
      color: "var(--muted-foreground)",
      pointerEvents: "none"
    }
  }, startIcon), /*#__PURE__*/React.createElement("input", _extends({
    className: className,
    onFocus: e => {
      setFocused(true);
      props.onFocus?.(e);
    },
    onBlur: e => {
      setFocused(false);
      props.onBlur?.(e);
    },
    style: {
      width: "100%",
      height: h,
      padding: startIcon ? "0 12px 0 32px" : "0 12px",
      fontFamily: "var(--font-sans)",
      fontSize: 13,
      color: "var(--foreground)",
      background: "var(--background-2)",
      border: `1px solid ${invalid ? "var(--destructive)" : focused ? "var(--ring)" : "var(--input)"}`,
      borderRadius: "var(--radius-md)",
      outline: "none",
      boxShadow: focused ? "var(--glow-violet)" : "none",
      transition: "border-color var(--motion-micro), box-shadow var(--motion-micro)",
      ...style
    }
  }, props)));
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Input.jsx", error: String((e && e.message) || e) }); }

// components/core/Switch.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Oxagen toggle switch. On = brand violet track with a glow. */
function Switch({
  checked,
  defaultChecked = false,
  onChange,
  disabled = false,
  style,
  ...props
}) {
  const [on, setOn] = React.useState(checked ?? defaultChecked);
  const isOn = checked ?? on;
  function toggle() {
    if (disabled) return;
    const next = !isOn;
    if (checked === undefined) setOn(next);
    onChange?.(next);
  }
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    role: "switch",
    "aria-checked": isOn,
    disabled: disabled,
    onClick: toggle,
    style: {
      position: "relative",
      width: 38,
      height: 22,
      borderRadius: 999,
      border: "1px solid",
      borderColor: isOn ? "transparent" : "var(--border-strong)",
      background: isOn ? "var(--primary)" : "var(--muted)",
      boxShadow: isOn ? "var(--glow-violet)" : "none",
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.5 : 1,
      padding: 0,
      transition: "background var(--motion-base) var(--ease-hover), box-shadow var(--motion-base)",
      ...style
    }
  }, props), /*#__PURE__*/React.createElement("span", {
    style: {
      position: "absolute",
      top: 2,
      left: isOn ? 18 : 2,
      width: 16,
      height: 16,
      borderRadius: "50%",
      background: "#fff",
      boxShadow: "0 1px 2px rgba(0,0,0,.4)",
      transition: "left var(--motion-base) var(--ease-hover)"
    }
  }));
}
Object.assign(__ds_scope, { Switch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Switch.jsx", error: String((e && e.message) || e) }); }

// components/core/Textarea.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** Oxagen multi-line textarea. Matches Input styling; violet focus glow. */
function Textarea({
  invalid = false,
  style,
  className,
  rows = 3,
  ...props
}) {
  const [focused, setFocused] = React.useState(false);
  return /*#__PURE__*/React.createElement("textarea", _extends({
    rows: rows,
    className: className,
    onFocus: e => {
      setFocused(true);
      props.onFocus?.(e);
    },
    onBlur: e => {
      setFocused(false);
      props.onBlur?.(e);
    },
    style: {
      width: "100%",
      padding: "10px 12px",
      fontFamily: "var(--font-sans)",
      fontSize: 13,
      lineHeight: 1.55,
      color: "var(--foreground)",
      background: "var(--background-2)",
      border: `1px solid ${invalid ? "var(--destructive)" : focused ? "var(--ring)" : "var(--input)"}`,
      borderRadius: "var(--radius-md)",
      outline: "none",
      resize: "vertical",
      boxShadow: focused ? "var(--glow-violet)" : "none",
      transition: "border-color var(--motion-micro), box-shadow var(--motion-micro)",
      ...style
    }
  }, props));
}
Object.assign(__ds_scope, { Textarea });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Textarea.jsx", error: String((e && e.message) || e) }); }

// components/layout/Panel.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Oxagen Panel — a titled surface container with an optional header eyebrow,
 * actions slot, and footer. The workhorse layout block for settings, detail
 * views and dashboards. `inset` removes body padding for flush content (tables).
 */
function Panel({
  title,
  eyebrow,
  actions,
  footer,
  inset = false,
  children,
  style,
  className,
  ...props
}) {
  return /*#__PURE__*/React.createElement("section", _extends({
    className: className,
    style: {
      display: "flex",
      flexDirection: "column",
      background: "var(--card)",
      color: "var(--card-foreground)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-xl)",
      boxShadow: "var(--shadow-sm)",
      overflow: "hidden",
      ...style
    }
  }, props), (title || actions || eyebrow) && /*#__PURE__*/React.createElement("header", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "15px 18px",
      borderBottom: "1px solid var(--border)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, eyebrow && /*#__PURE__*/React.createElement("div", {
    className: "ox-eyebrow",
    style: {
      marginBottom: 3
    }
  }, eyebrow), title && /*#__PURE__*/React.createElement("h3", {
    style: {
      fontSize: 15,
      fontWeight: 600,
      letterSpacing: "-0.01em",
      margin: 0
    }
  }, title)), actions && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      flexShrink: 0
    }
  }, actions)), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: inset ? 0 : 18,
      flex: 1,
      minHeight: 0
    }
  }, children), footer && /*#__PURE__*/React.createElement("footer", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "13px 18px",
      borderTop: "1px solid var(--border)",
      background: "var(--background-2)"
    }
  }, footer));
}
Object.assign(__ds_scope, { Panel });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/layout/Panel.jsx", error: String((e && e.message) || e) }); }

// components/lib/motion.js
try { (() => {
/*
 * motion.js — progressive-enhancement bridge to framer-motion.
 *
 * framer-motion is loaded by the consuming HTML as a UMD global (window.Motion).
 * Resolution is LAZY (read at call/render time, not module-eval) so script
 * ordering is forgiving: as long as framer-motion is present by first render,
 * components animate; if it never loads, they render statically (motion props
 * are stripped so there are no invalid-DOM-attribute warnings).
 */

function fm() {
  return typeof window !== "undefined" && window.Motion || null;
}
function hasMotion() {
  const f = fm();
  return !!(f && f.motion);
}

/** AnimatePresence passthrough that resolves framer-motion lazily. */
function AnimatePresence(props) {
  const f = fm();
  if (f && f.AnimatePresence) return React.createElement(f.AnimatePresence, props);
  return React.createElement(React.Fragment, null, props.children);
}
function MotionConfig(props) {
  const f = fm();
  if (f && f.MotionConfig) return React.createElement(f.MotionConfig, props);
  return React.createElement(React.Fragment, null, props.children);
}
const STRIP = new Set(["initial", "animate", "exit", "transition", "variants", "custom", "whileHover", "whileTap", "whileFocus", "whileInView", "whileDrag", "layout", "layoutId", "layoutScroll", "drag", "dragConstraints", "dragElastic", "onAnimationStart", "onAnimationComplete", "viewport", "inherit"]);
const fallbackCache = {};

/** m("div") → framer-motion's motion.div, or a prop-stripping plain element. */
function m(tag) {
  const f = fm();
  if (f && f.motion) return f.motion[tag];
  if (fallbackCache[tag]) return fallbackCache[tag];
  const Comp = React.forwardRef(function Plain(props, ref) {
    const clean = {};
    for (const k in props) if (!STRIP.has(k)) clean[k] = props[k];
    return React.createElement(tag, {
      ref,
      ...clean
    });
  });
  fallbackCache[tag] = Comp;
  return Comp;
}

/* Motion presets aligned to the product tokens. */
const SPRING = {
  type: "spring",
  stiffness: 420,
  damping: 32,
  mass: 0.8
};
/** Bouncy spring for tactile press/hover feedback. */
const BOUNCE = {
  type: "spring",
  stiffness: 520,
  damping: 14,
  mass: 0.6
};
const EASE_ENTRY = [0.16, 1, 0.3, 1];
const EASE_EXIT = [0.4, 0, 1, 1];
Object.assign(__ds_scope, { hasMotion, AnimatePresence, MotionConfig, m, SPRING, BOUNCE, EASE_ENTRY, EASE_EXIT });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/lib/motion.js", error: String((e && e.message) || e) }); }

// components/code/CodeTabs.jsx
try { (() => {
/**
 * Oxagen CodeTabs — multi-language code sample. A tab per language (with its
 * language glyph), a copy button bound to the active tab, and a fade between
 * languages. The dev-docs pattern for "here's the same call in TS / Python / cURL".
 * `tabs: { language, label?, filename?, code }[]`.
 */
function CodeTabs({
  tabs = [],
  defaultIndex = 0,
  showLineNumbers = false,
  style
}) {
  const [idx, setIdx] = React.useState(defaultIndex);
  const active = tabs[idx] || {
    code: "",
    language: ""
  };
  const Body = __ds_scope.m("div");
  const lines = (active.code || "").replace(/\n$/, "").split("\n");
  return /*#__PURE__*/React.createElement("div", {
    style: {
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-lg)",
      background: "var(--background-2)",
      overflow: "hidden",
      ...style
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 4,
      padding: "6px 8px",
      borderBottom: "1px solid var(--border)",
      background: "var(--card)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 2,
      overflowX: "auto"
    }
  }, tabs.map((t, i) => {
    const on = i === idx;
    return /*#__PURE__*/React.createElement("button", {
      key: i,
      onClick: () => setIdx(i),
      style: {
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: "5px 10px",
        borderRadius: "var(--radius-sm)",
        border: "1px solid transparent",
        background: on ? "var(--background-2)" : "transparent",
        boxShadow: on ? "inset 0 0 0 1px var(--border)" : "none",
        color: on ? "var(--foreground)" : "var(--muted-foreground)",
        fontFamily: "var(--font-sans)",
        fontSize: 12.5,
        fontWeight: on ? 600 : 500,
        cursor: "pointer",
        whiteSpace: "nowrap"
      }
    }, /*#__PURE__*/React.createElement(__ds_scope.LangIcon, {
      language: t.language,
      size: 17
    }), t.label || t.filename || t.language);
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: "auto"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.CopyButton, {
    getText: () => active.code
  }))), /*#__PURE__*/React.createElement(__ds_scope.AnimatePresence, {
    mode: "wait",
    initial: false
  }, /*#__PURE__*/React.createElement(Body, {
    key: idx,
    initial: {
      opacity: 0
    },
    animate: {
      opacity: 1
    },
    exit: {
      opacity: 0
    },
    transition: {
      duration: 0.16
    }
  }, /*#__PURE__*/React.createElement("pre", {
    style: {
      margin: 0,
      padding: "14px 16px",
      overflowX: "auto",
      fontFamily: "var(--font-mono)",
      fontSize: 12.5,
      lineHeight: 1.65
    }
  }, /*#__PURE__*/React.createElement("code", {
    style: {
      fontFamily: "inherit",
      display: "block"
    }
  }, showLineNumbers ? lines.map((ln, i) => /*#__PURE__*/React.createElement("span", {
    key: i,
    style: {
      display: "grid",
      gridTemplateColumns: "2ch 1fr",
      gap: 14
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted-foreground)",
      opacity: 0.5,
      userSelect: "none",
      textAlign: "right"
    }
  }, i + 1), /*#__PURE__*/React.createElement("span", null, __ds_scope.highlight(ln), "\n"))) : __ds_scope.highlight(active.code || ""))))));
}
Object.assign(__ds_scope, { CodeTabs });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/code/CodeTabs.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Oxagen Button.
 * Jewel-tone, high-contrast, with a tactile spring bounce on hover/press
 * (framer-motion). `gradient` is the signature hero action. Compact density.
 */
const RADIUS = "var(--radius-md)";
const SIZES = {
  sm: {
    height: 28,
    padding: "0 12px",
    fontSize: 12,
    gap: 6
  },
  md: {
    height: 36,
    padding: "0 16px",
    fontSize: 13,
    gap: 8
  },
  lg: {
    height: 44,
    padding: "0 22px",
    fontSize: 15,
    gap: 8
  },
  icon: {
    height: 36,
    width: 36,
    padding: 0,
    fontSize: 13,
    gap: 0
  }
};
function variantStyle(variant) {
  switch (variant) {
    case "gradient":
      return {
        background: "var(--grad-sunset)",
        color: "#fff",
        border: "1px solid transparent",
        boxShadow: "var(--glow-violet)"
      };
    case "secondary":
      return {
        background: "var(--secondary)",
        color: "var(--secondary-foreground)",
        border: "1px solid var(--border)"
      };
    case "outline":
      return {
        background: "transparent",
        color: "var(--foreground)",
        border: "1px solid var(--border-strong)"
      };
    case "ghost":
      return {
        background: "transparent",
        color: "var(--foreground)",
        border: "1px solid transparent"
      };
    case "destructive":
      return {
        background: "var(--destructive)",
        color: "var(--destructive-foreground)",
        border: "1px solid transparent"
      };
    case "link":
      return {
        background: "transparent",
        color: "var(--brand)",
        border: "1px solid transparent",
        padding: 0,
        height: "auto"
      };
    case "primary":
    default:
      return {
        background: "var(--primary)",
        color: "var(--primary-foreground)",
        border: "1px solid transparent"
      };
  }
}
function Button({
  variant = "primary",
  size = "md",
  disabled = false,
  iconOnly = false,
  startIcon = null,
  endIcon = null,
  children,
  style,
  className,
  ...props
}) {
  const sz = SIZES[iconOnly ? "icon" : size] || SIZES.md;
  const vs = variantStyle(variant);
  const [hover, setHover] = React.useState(false);
  const MButton = __ds_scope.m("button");
  const isLink = variant === "link";
  const base = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: sz.gap,
    height: sz.height,
    width: iconOnly ? sz.width : "auto",
    padding: sz.padding,
    fontFamily: "var(--font-sans)",
    fontSize: sz.fontSize,
    fontWeight: 600,
    lineHeight: 1,
    letterSpacing: "-0.01em",
    borderRadius: RADIUS,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    whiteSpace: "nowrap",
    filter: !disabled && hover ? "brightness(1.08)" : "none",
    transition: "filter var(--motion-micro) var(--ease-hover), background var(--motion-micro) var(--ease-hover)",
    ...vs,
    ...style
  };
  const motionProps = disabled || isLink ? {} : {
    whileHover: {
      scale: 1.035,
      y: -1
    },
    whileTap: {
      scale: 0.92,
      y: 0
    },
    transition: __ds_scope.BOUNCE
  };
  return /*#__PURE__*/React.createElement(MButton, _extends({
    type: "button",
    disabled: disabled,
    className: className,
    style: base,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false)
  }, motionProps, props), startIcon, children, endIcon);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/Tabs.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Oxagen Tabs — underline style with a gradient indicator that SLIDES between
 * tabs (framer-motion shared layout). Controlled or uncontrolled.
 * `items: { value, label, icon?, badge? }[]`.
 */
function Tabs({
  items = [],
  value,
  defaultValue,
  onChange,
  style,
  ...props
}) {
  const [val, setVal] = React.useState(defaultValue ?? items[0]?.value);
  const active = value ?? val;
  const groupId = React.useId();
  const Indicator = __ds_scope.m("span");
  function select(v) {
    if (value === undefined) setVal(v);
    onChange?.(v);
  }
  return /*#__PURE__*/React.createElement("div", _extends({
    role: "tablist",
    style: {
      display: "flex",
      gap: 2,
      borderBottom: "1px solid var(--border)",
      ...style
    }
  }, props), items.map(it => {
    const on = it.value === active;
    return /*#__PURE__*/React.createElement("button", {
      key: it.value,
      role: "tab",
      "aria-selected": on,
      onClick: () => select(it.value),
      style: {
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: "10px 14px",
        background: "transparent",
        border: "none",
        cursor: "pointer",
        fontFamily: "var(--font-sans)",
        fontSize: 13,
        fontWeight: on ? 600 : 500,
        color: on ? "var(--foreground)" : "var(--muted-foreground)",
        transition: "color var(--motion-micro)"
      }
    }, it.icon, it.label, it.badge != null && /*#__PURE__*/React.createElement("span", {
      style: {
        fontSize: 10,
        fontWeight: 600,
        color: "var(--muted-foreground)",
        background: "var(--muted)",
        borderRadius: 999,
        padding: "1px 6px"
      }
    }, it.badge), on && /*#__PURE__*/React.createElement(Indicator, {
      layoutId: `ox-tabs-ind-${groupId}`,
      transition: __ds_scope.SPRING,
      style: {
        position: "absolute",
        left: 8,
        right: 8,
        bottom: -1,
        height: 2,
        borderRadius: 2,
        background: "var(--grad-sunset)"
      }
    }));
  }));
}
Object.assign(__ds_scope, { Tabs });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Tabs.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Dialog.jsx
try { (() => {
/**
 * Oxagen Dialog — centered modal with a blurred scrim. Animates in/out with
 * framer-motion (scrim fade + content spring-up). Controlled via `open`.
 */
function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 460
}) {
  React.useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose?.();
    }
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  const Scrim = __ds_scope.m("div");
  const Panel = __ds_scope.m("div");
  return /*#__PURE__*/React.createElement(__ds_scope.AnimatePresence, null, open && /*#__PURE__*/React.createElement(Scrim, {
    key: "scrim",
    onClick: onClose,
    initial: {
      opacity: 0
    },
    animate: {
      opacity: 1
    },
    exit: {
      opacity: 0
    },
    transition: {
      duration: 0.18
    },
    style: {
      position: "fixed",
      inset: 0,
      zIndex: 60,
      display: "grid",
      placeItems: "center",
      padding: 20,
      background: "color-mix(in oklch, var(--ink-950) 60%, transparent)",
      backdropFilter: "blur(6px)",
      WebkitBackdropFilter: "blur(6px)"
    }
  }, /*#__PURE__*/React.createElement(Panel, {
    key: "panel",
    onClick: e => e.stopPropagation(),
    initial: {
      opacity: 0,
      y: 16,
      scale: 0.97
    },
    animate: {
      opacity: 1,
      y: 0,
      scale: 1
    },
    exit: {
      opacity: 0,
      y: 8,
      scale: 0.98,
      transition: {
        duration: 0.14,
        ease: __ds_scope.EASE_EXIT
      }
    },
    transition: __ds_scope.SPRING,
    role: "dialog",
    "aria-modal": "true",
    style: {
      width: "100%",
      maxWidth: width,
      background: "var(--popover)",
      color: "var(--popover-foreground)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-xl)",
      boxShadow: "var(--shadow-xl)",
      overflow: "hidden"
    }
  }, (title || description) && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "20px 22px 0"
    }
  }, title && /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 18,
      fontWeight: 600,
      letterSpacing: "-0.01em",
      margin: 0
    }
  }, title), description && /*#__PURE__*/React.createElement("p", {
    style: {
      margin: "6px 0 0",
      fontSize: 13.5,
      lineHeight: 1.55,
      color: "var(--muted-foreground)"
    }
  }, description)), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "16px 22px",
      fontSize: 13.5,
      lineHeight: 1.6
    }
  }, children), footer && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "flex-end",
      gap: 8,
      padding: "0 22px 20px"
    }
  }, footer))));
}
Object.assign(__ds_scope, { Dialog });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Dialog.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Drawer.jsx
try { (() => {
/**
 * Oxagen Drawer — edge-anchored sliding panel with a scrim. `side` controls the
 * edge (right/left/bottom). Animates with a spring slide. Controlled via `open`.
 */
function Drawer({
  open,
  onClose,
  side = "right",
  title,
  description,
  children,
  footer,
  size = 380
}) {
  React.useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose?.();
    }
    if (open) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  const vertical = side === "bottom";
  const off = side === "left" ? {
    x: "-100%"
  } : side === "bottom" ? {
    y: "100%"
  } : {
    x: "100%"
  };
  const anchor = side === "left" ? {
    top: 0,
    left: 0,
    bottom: 0
  } : side === "bottom" ? {
    left: 0,
    right: 0,
    bottom: 0
  } : {
    top: 0,
    right: 0,
    bottom: 0
  };
  const Scrim = __ds_scope.m("div");
  const Panel = __ds_scope.m("aside");
  return /*#__PURE__*/React.createElement(__ds_scope.AnimatePresence, null, open && /*#__PURE__*/React.createElement(Scrim, {
    key: "scrim",
    onClick: onClose,
    initial: {
      opacity: 0
    },
    animate: {
      opacity: 1
    },
    exit: {
      opacity: 0
    },
    transition: {
      duration: 0.18
    },
    style: {
      position: "fixed",
      inset: 0,
      zIndex: 70,
      background: "color-mix(in oklch, var(--ink-950) 58%, transparent)",
      backdropFilter: "blur(4px)",
      WebkitBackdropFilter: "blur(4px)"
    }
  }, /*#__PURE__*/React.createElement(Panel, {
    key: "panel",
    onClick: e => e.stopPropagation(),
    initial: off,
    animate: {
      x: 0,
      y: 0
    },
    exit: off,
    transition: __ds_scope.SPRING,
    style: {
      position: "fixed",
      ...anchor,
      width: vertical ? "auto" : size,
      height: vertical ? size : "auto",
      maxWidth: "100vw",
      display: "flex",
      flexDirection: "column",
      background: "var(--card)",
      color: "var(--card-foreground)",
      borderLeft: side === "right" ? "1px solid var(--border)" : "none",
      borderRight: side === "left" ? "1px solid var(--border)" : "none",
      borderTop: side === "bottom" ? "1px solid var(--border)" : "none",
      borderTopLeftRadius: side === "bottom" ? "var(--radius-xl)" : 0,
      borderTopRightRadius: side === "bottom" ? "var(--radius-xl)" : 0,
      boxShadow: "var(--shadow-xl)"
    }
  }, /*#__PURE__*/React.createElement("header", {
    style: {
      display: "flex",
      alignItems: "flex-start",
      gap: 10,
      padding: "18px 20px 0"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, title && /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: 17,
      fontWeight: 600,
      letterSpacing: "-0.01em",
      margin: 0
    }
  }, title), description && /*#__PURE__*/React.createElement("p", {
    style: {
      margin: "5px 0 0",
      fontSize: 13,
      color: "var(--muted-foreground)",
      lineHeight: 1.5
    }
  }, description)), /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    "aria-label": "Close",
    style: {
      background: "transparent",
      border: "none",
      color: "var(--muted-foreground)",
      cursor: "pointer",
      fontSize: 18,
      lineHeight: 1,
      padding: 2
    }
  }, "\xD7")), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      overflowY: "auto",
      padding: 20
    }
  }, children), footer && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "flex-end",
      gap: 8,
      padding: "0 20px 18px"
    }
  }, footer))));
}
Object.assign(__ds_scope, { Drawer });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Drawer.jsx", error: String((e && e.message) || e) }); }

// components/feedback/ToastProvider.jsx
try { (() => {
/**
 * Oxagen Toast system. Wrap your app in <ToastProvider>, then call
 * useToast().push({ title, description, tone, icon }). Toasts stack bottom-right
 * and animate in with a spring + auto-dismiss.
 */
const ToastCtx = React.createContext(null);
const TONES = {
  default: ["var(--border)", "var(--ox-violet-bright, #9b7bff)"],
  success: ["color-mix(in oklch, var(--success) 50%, var(--border))", "#67d182"],
  warning: ["color-mix(in oklch, var(--warning) 50%, var(--border))", "#ffbe63"],
  danger: ["color-mix(in oklch, var(--destructive) 50%, var(--border))", "#ff8a6b"],
  cyan: ["color-mix(in oklch, var(--cyan-400) 50%, var(--border))", "var(--cyan-300)"]
};
function ToastProvider({
  children
}) {
  const [toasts, setToasts] = React.useState([]);
  const push = React.useCallback(t => {
    const id = Math.random().toString(36).slice(2);
    setToasts(cur => [...cur, {
      id,
      tone: "default",
      duration: 4000,
      ...t
    }]);
    return id;
  }, []);
  const dismiss = React.useCallback(id => setToasts(cur => cur.filter(t => t.id !== id)), []);
  React.useEffect(() => {
    const timers = toasts.map(t => setTimeout(() => dismiss(t.id), t.duration));
    return () => timers.forEach(clearTimeout);
  }, [toasts, dismiss]);
  const Item = __ds_scope.m("div");
  return /*#__PURE__*/React.createElement(ToastCtx.Provider, {
    value: {
      push,
      dismiss
    }
  }, children, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "fixed",
      right: 16,
      bottom: 16,
      zIndex: 80,
      display: "flex",
      flexDirection: "column",
      gap: 10,
      width: 320,
      maxWidth: "calc(100vw - 32px)"
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.AnimatePresence, null, toasts.map(t => {
    const [bd, accent] = TONES[t.tone] || TONES.default;
    return /*#__PURE__*/React.createElement(Item, {
      key: t.id,
      layout: true,
      initial: {
        opacity: 0,
        x: 24,
        scale: 0.96
      },
      animate: {
        opacity: 1,
        x: 0,
        scale: 1
      },
      exit: {
        opacity: 0,
        x: 24,
        scale: 0.96
      },
      transition: __ds_scope.SPRING,
      style: {
        display: "flex",
        gap: 11,
        padding: "12px 13px",
        background: "var(--popover)",
        color: "var(--popover-foreground)",
        border: `1px solid ${bd}`,
        borderRadius: "var(--radius-lg)",
        boxShadow: "var(--shadow-lg)"
      }
    }, t.icon && /*#__PURE__*/React.createElement("span", {
      style: {
        color: accent,
        marginTop: 1,
        flexShrink: 0
      }
    }, t.icon), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        minWidth: 0
      }
    }, t.title && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 13,
        fontWeight: 600
      }
    }, t.title), t.description && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12.5,
        color: "var(--muted-foreground)",
        marginTop: 1,
        lineHeight: 1.45
      }
    }, t.description)), /*#__PURE__*/React.createElement("button", {
      onClick: () => dismiss(t.id),
      "aria-label": "Dismiss",
      style: {
        background: "transparent",
        border: "none",
        color: "var(--muted-foreground)",
        cursor: "pointer",
        fontSize: 15,
        lineHeight: 1,
        padding: 2,
        alignSelf: "flex-start"
      }
    }, "\xD7"));
  }))));
}
function useToast() {
  const ctx = React.useContext(ToastCtx);
  if (!ctx) return {
    push: () => {},
    dismiss: () => {}
  };
  return ctx;
}
Object.assign(__ds_scope, { ToastProvider, useToast });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/ToastProvider.jsx", error: String((e && e.message) || e) }); }

// components/flows/Stepper.jsx
try { (() => {
/**
 * Oxagen Stepper — horizontal step progresser. Completed steps fill with a
 * gradient + check; the active step pulses a glow; the connector line fills as
 * you advance. `steps: { label, description? }[]`, `current` is the 0-based index.
 */
function Stepper({
  steps = [],
  current = 0,
  style
}) {
  const Fill = __ds_scope.m("span");
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "flex-start",
      ...style
    }
  }, steps.map((s, i) => {
    const done = i < current;
    const active = i === current;
    const last = i === steps.length - 1;
    return /*#__PURE__*/React.createElement(React.Fragment, {
      key: i
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        flexShrink: 0,
        width: 132
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        width: 30,
        height: 30,
        borderRadius: "50%",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 13,
        fontWeight: 600,
        background: done || active ? "var(--grad-sunset)" : "var(--muted)",
        color: done || active ? "#fff" : "var(--muted-foreground)",
        border: active ? "1px solid transparent" : done ? "1px solid transparent" : "1px solid var(--border)",
        boxShadow: active ? "var(--glow-violet)" : "none"
      }
    }, done ? /*#__PURE__*/React.createElement("svg", {
      width: "15",
      height: "15",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "3",
      strokeLinecap: "round",
      strokeLinejoin: "round"
    }, /*#__PURE__*/React.createElement("path", {
      d: "M20 6 9 17l-5-5"
    })) : i + 1), /*#__PURE__*/React.createElement("div", {
      style: {
        textAlign: "center",
        padding: "0 4px"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12.5,
        fontWeight: active ? 600 : 500,
        color: active || done ? "var(--foreground)" : "var(--muted-foreground)"
      }
    }, s.label), s.description && /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 11,
        color: "var(--muted-foreground)",
        marginTop: 1,
        lineHeight: 1.35
      }
    }, s.description))), !last && /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        height: 2,
        background: "var(--border)",
        borderRadius: 2,
        marginTop: 14,
        position: "relative",
        overflow: "hidden"
      }
    }, /*#__PURE__*/React.createElement(Fill, {
      initial: false,
      animate: {
        scaleX: done ? 1 : 0
      },
      transition: {
        duration: 0.35,
        ease: [0.16, 1, 0.3, 1]
      },
      style: {
        position: "absolute",
        inset: 0,
        transformOrigin: "left",
        background: "var(--grad-sunset)"
      }
    })));
  }));
}
Object.assign(__ds_scope, { Stepper });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/flows/Stepper.jsx", error: String((e && e.message) || e) }); }

// components/flows/OnboardingWizard.jsx
try { (() => {
/**
 * Oxagen OnboardingWizard — a multi-step flow shell wrapping the Stepper with
 * animated step transitions (slide+fade) and Back/Next controls. Provide
 * `steps: { label, description?, render: (ctx) => node }[]`. The wizard tracks
 * the current index, calls `onComplete()` on the final Next, and exposes
 * `{ index, goNext, goBack, setData, data }` to each step's render.
 */
function OnboardingWizard({
  steps = [],
  onComplete = () => {},
  initialData = {},
  style
}) {
  const [index, setIndex] = React.useState(0);
  const [dir, setDir] = React.useState(1);
  const [data, setData] = React.useState(initialData);
  const last = index === steps.length - 1;
  function goNext() {
    if (last) return onComplete(data);
    setDir(1);
    setIndex(i => Math.min(i + 1, steps.length - 1));
  }
  function goBack() {
    if (index === 0) return;
    setDir(-1);
    setIndex(i => Math.max(i - 1, 0));
  }
  const update = patch => setData(d => ({
    ...d,
    ...patch
  }));
  const ctx = {
    index,
    goNext,
    goBack,
    data,
    setData: update
  };
  const Slide = __ds_scope.m("div");
  const step = steps[index] || {};
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 22,
      ...style
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.Stepper, {
    steps: steps.map(s => ({
      label: s.label,
      description: s.description
    })),
    current: index
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative",
      minHeight: 220
    }
  }, /*#__PURE__*/React.createElement(__ds_scope.AnimatePresence, {
    mode: "wait",
    initial: false
  }, /*#__PURE__*/React.createElement(Slide, {
    key: index,
    initial: {
      opacity: 0,
      x: dir * 28
    },
    animate: {
      opacity: 1,
      x: 0
    },
    exit: {
      opacity: 0,
      x: dir * -28
    },
    transition: {
      duration: 0.26,
      ease: [0.16, 1, 0.3, 1]
    }
  }, typeof step.render === "function" ? step.render(ctx) : step.render))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: goBack,
    disabled: index === 0,
    style: {
      height: 38,
      padding: "0 16px",
      borderRadius: "var(--radius-md)",
      border: "1px solid var(--border)",
      background: "transparent",
      color: "var(--foreground)",
      fontSize: 13,
      fontWeight: 500,
      cursor: index === 0 ? "not-allowed" : "pointer",
      opacity: index === 0 ? 0.45 : 1,
      fontFamily: "var(--font-sans)"
    }
  }, "Back"), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: "auto",
      fontSize: 12.5,
      color: "var(--muted-foreground)"
    }
  }, "Step ", index + 1, " of ", steps.length), /*#__PURE__*/React.createElement("button", {
    onClick: goNext,
    style: {
      height: 38,
      padding: "0 20px",
      borderRadius: "var(--radius-md)",
      border: "1px solid transparent",
      background: "var(--grad-sunset)",
      color: "#fff",
      fontSize: 13,
      fontWeight: 600,
      cursor: "pointer",
      boxShadow: "var(--glow-violet)",
      fontFamily: "var(--font-sans)"
    }
  }, last ? "Finish setup" : "Continue")));
}
Object.assign(__ds_scope, { OnboardingWizard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/flows/OnboardingWizard.jsx", error: String((e && e.message) || e) }); }

// components/layout/Collapse.jsx
try { (() => {
/**
 * Oxagen Collapse — a single expandable disclosure row. Chevron rotates and the
 * body height-animates open/closed. Controlled (`open`) or uncontrolled
 * (`defaultOpen`).
 */
function Collapse({
  title,
  subtitle,
  icon,
  defaultOpen = false,
  open,
  onToggle,
  children,
  style
}) {
  const [internal, setInternal] = React.useState(defaultOpen);
  const isOpen = open ?? internal;
  function toggle() {
    if (open === undefined) setInternal(v => !v);
    onToggle?.(!isOpen);
  }
  const Body = __ds_scope.m("div");
  const Chev = __ds_scope.m("span");
  return /*#__PURE__*/React.createElement("div", {
    style: {
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-lg)",
      background: "var(--card)",
      overflow: "hidden",
      ...style
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: toggle,
    "aria-expanded": isOpen,
    style: {
      display: "flex",
      alignItems: "center",
      gap: 11,
      width: "100%",
      padding: "13px 15px",
      background: "transparent",
      border: "none",
      cursor: "pointer",
      textAlign: "left",
      color: "var(--foreground)"
    }
  }, icon && /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--ox-violet-bright, #9b7bff)",
      display: "inline-flex"
    }
  }, icon), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "block",
      fontSize: 13.5,
      fontWeight: 600
    }
  }, title), subtitle && /*#__PURE__*/React.createElement("span", {
    style: {
      display: "block",
      fontSize: 12,
      color: "var(--muted-foreground)",
      marginTop: 1
    }
  }, subtitle)), /*#__PURE__*/React.createElement(Chev, {
    animate: {
      rotate: isOpen ? 90 : 0
    },
    transition: {
      duration: 0.2
    },
    style: {
      color: "var(--muted-foreground)",
      display: "inline-flex",
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("svg", {
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, /*#__PURE__*/React.createElement("path", {
    d: "m9 18 6-6-6-6"
  })))), /*#__PURE__*/React.createElement(__ds_scope.AnimatePresence, {
    initial: false
  }, isOpen && /*#__PURE__*/React.createElement(Body, {
    key: "body",
    initial: {
      height: 0,
      opacity: 0
    },
    animate: {
      height: "auto",
      opacity: 1
    },
    exit: {
      height: 0,
      opacity: 0
    },
    transition: {
      duration: 0.24,
      ease: [0.16, 1, 0.3, 1]
    },
    style: {
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "0 15px 15px",
      fontSize: 13,
      lineHeight: 1.6,
      color: "var(--muted-foreground)"
    }
  }, children))));
}
Object.assign(__ds_scope, { Collapse });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/layout/Collapse.jsx", error: String((e && e.message) || e) }); }

// components/layout/MainNav.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Oxagen MainNav — a horizontal top navigation bar (marketing / docs use).
 * Brand on the left, center links with a sliding gradient underline indicator,
 * actions on the right. `items: { id, label, href? }[]`.
 */
function MainNav({
  brand,
  items = [],
  active,
  onSelect = () => {},
  actions,
  sticky = false,
  style,
  ...props
}) {
  const [hovered, setHovered] = React.useState(null);
  const Underline = __ds_scope.m("span");
  return /*#__PURE__*/React.createElement("header", _extends({
    style: {
      position: sticky ? "sticky" : "relative",
      top: 0,
      zIndex: 40,
      display: "flex",
      alignItems: "center",
      gap: 20,
      height: 60,
      padding: "0 22px",
      background: "color-mix(in oklch, var(--background) 78%, transparent)",
      backdropFilter: "blur(12px)",
      WebkitBackdropFilter: "blur(12px)",
      borderBottom: "1px solid var(--border)",
      ...style
    }
  }, props), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      flexShrink: 0
    }
  }, brand), /*#__PURE__*/React.createElement("nav", {
    onMouseLeave: () => setHovered(null),
    style: {
      display: "flex",
      alignItems: "center",
      gap: 4,
      margin: "0 auto"
    }
  }, items.map(it => {
    const on = active === it.id;
    const showInd = (hovered ?? active) === it.id;
    return /*#__PURE__*/React.createElement("a", {
      key: it.id,
      href: it.href || "#",
      onClick: e => {
        if (!it.href) e.preventDefault();
        onSelect(it.id);
      },
      onMouseEnter: () => setHovered(it.id),
      style: {
        position: "relative",
        padding: "8px 14px",
        borderRadius: "var(--radius-md)",
        textDecoration: "none",
        fontSize: 13.5,
        fontWeight: on ? 600 : 500,
        color: on ? "var(--foreground)" : "var(--muted-foreground)",
        transition: "color var(--motion-micro)"
      }
    }, it.label, showInd && /*#__PURE__*/React.createElement(Underline, {
      layoutId: "ox-mainnav-underline",
      style: {
        position: "absolute",
        left: 12,
        right: 12,
        bottom: 2,
        height: 2,
        borderRadius: 2,
        background: "var(--grad-sunset)"
      }
    }));
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      flexShrink: 0
    }
  }, actions));
}
Object.assign(__ds_scope, { MainNav });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/layout/MainNav.jsx", error: String((e && e.message) || e) }); }

// components/layout/Sidebar.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Oxagen Sidebar — the vertical product nav. Renders grouped items with a
 * gradient active-accent bar that slides between items (framer-motion shared
 * layout). `groups: { label?, items: { id, label, icon?, badge? }[] }[]`.
 * `header` / `footer` slot the brand lockup and account row.
 */
function Item({
  item,
  active,
  onSelect
}) {
  const [hover, setHover] = React.useState(false);
  const Bar = __ds_scope.m("span");
  return /*#__PURE__*/React.createElement("button", {
    onClick: () => onSelect(item.id),
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      position: "relative",
      display: "flex",
      alignItems: "center",
      gap: 10,
      width: "100%",
      padding: "8px 10px",
      borderRadius: "var(--radius-md)",
      border: "none",
      cursor: "pointer",
      textAlign: "left",
      fontFamily: "var(--font-sans)",
      fontSize: 13,
      fontWeight: active ? 600 : 500,
      color: active ? "var(--foreground)" : "var(--muted-foreground)",
      background: active ? "var(--sidebar-accent)" : hover ? "color-mix(in oklch, var(--sidebar-accent) 55%, transparent)" : "transparent",
      transition: "background var(--motion-micro), color var(--motion-micro)"
    }
  }, active && /*#__PURE__*/React.createElement(Bar, {
    layoutId: "ox-sidebar-active",
    style: {
      position: "absolute",
      left: 0,
      top: 7,
      bottom: 7,
      width: 3,
      borderRadius: 3,
      background: "var(--grad-sunset)"
    }
  }), item.icon && /*#__PURE__*/React.createElement("span", {
    style: {
      color: active ? "var(--ox-violet-bright, #9b7bff)" : "inherit",
      display: "inline-flex"
    }
  }, item.icon), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis"
    }
  }, item.label), item.badge != null && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      fontWeight: 600,
      color: "var(--muted-foreground)",
      background: "var(--muted)",
      borderRadius: 999,
      padding: "1px 7px"
    }
  }, item.badge));
}
function Sidebar({
  groups = [],
  active,
  onSelect = () => {},
  header,
  footer,
  width = 232,
  style,
  ...props
}) {
  return /*#__PURE__*/React.createElement("aside", _extends({
    style: {
      width,
      flexShrink: 0,
      display: "flex",
      flexDirection: "column",
      background: "var(--sidebar)",
      border: "1px solid var(--sidebar-border)",
      borderRadius: "var(--radius-xl)",
      boxShadow: "var(--shadow-md)",
      overflow: "hidden",
      ...style
    }
  }, props), header && /*#__PURE__*/React.createElement("div", {
    style: {
      flexShrink: 0
    }
  }, header), /*#__PURE__*/React.createElement("nav", {
    style: {
      flex: 1,
      padding: 8,
      display: "flex",
      flexDirection: "column",
      gap: 2,
      overflowY: "auto"
    }
  }, groups.map((g, gi) => /*#__PURE__*/React.createElement("div", {
    key: gi,
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 2
    }
  }, gi > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      height: 1,
      background: "var(--sidebar-border)",
      margin: "8px 10px"
    }
  }), g.label && /*#__PURE__*/React.createElement("div", {
    className: "ox-eyebrow",
    style: {
      padding: "2px 12px 6px",
      fontSize: 10
    }
  }, g.label), g.items.map(it => /*#__PURE__*/React.createElement(Item, {
    key: it.id,
    item: it,
    active: active === it.id,
    onSelect: onSelect
  }))))), footer && /*#__PURE__*/React.createElement("div", {
    style: {
      flexShrink: 0,
      padding: 8,
      borderTop: "1px solid var(--sidebar-border)"
    }
  }, footer));
}
Object.assign(__ds_scope, { Sidebar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/layout/Sidebar.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/AccessScreen.jsx
try { (() => {
const {
  Badge,
  Button
} = window.OxagenDesignSystem_2dfe15;
const ROLES = [{
  name: "Owner",
  icon: "crown",
  color: "#ffbe63",
  members: 1,
  desc: "Full control. Billing, members, security, and every setting.",
  perms: [["Manage members", "full"], ["Manage billing", "full"], ["Configure security", "full"], ["Run agents", "full"], ["Delete org", "full"]]
}, {
  name: "Admin",
  icon: "shield-check",
  color: "#45dcef",
  members: 2,
  desc: "Invite members, manage workspaces, most org settings. No billing.",
  perms: [["Manage members", "full"], ["Manage billing", "none"], ["Configure security", "limited"], ["Run agents", "full"], ["Delete org", "none"]]
}, {
  name: "Billing",
  icon: "credit-card",
  color: "#67d182",
  members: 1,
  desc: "Read/write billing, subscriptions, usage. No members or security.",
  perms: [["Manage members", "none"], ["Manage billing", "full"], ["Configure security", "none"], ["Run agents", "limited"], ["Delete org", "none"]]
}, {
  name: "Member",
  icon: "users",
  color: "#9b7bff",
  members: 4,
  desc: "Standard access. Use agents and contribute to assigned workspaces.",
  perms: [["Manage members", "none"], ["Manage billing", "none"], ["Configure security", "none"], ["Run agents", "full"], ["Delete org", "none"]]
}, {
  name: "Viewer",
  icon: "eye",
  color: "var(--muted-foreground)",
  members: 2,
  desc: "Read-only across workspaces and knowledge. Cannot run agents.",
  perms: [["Manage members", "none"], ["Manage billing", "none"], ["Configure security", "none"], ["Run agents", "none"], ["Delete org", "none"]]
}, {
  name: "Custom",
  icon: "plus",
  color: "var(--ox-violet-bright)",
  members: 0,
  desc: "Compose a role from scoped permissions across the graph.",
  custom: true,
  perms: []
}];
function PermRow({
  label,
  state
}) {
  const icon = state === "full" ? ["check", "#67d182"] : state === "limited" ? ["minus", "#ffbe63"] : ["minus", "var(--muted-foreground)"];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "5px 0",
      fontSize: 12,
      borderTop: "1px solid color-mix(in oklch, var(--border) 60%, transparent)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted-foreground)"
    }
  }, label), /*#__PURE__*/React.createElement("span", {
    style: {
      color: icon[1],
      opacity: state === "none" ? 0.4 : 1
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: icon[0],
    size: 14
  })));
}
function RoleCard({
  role
}) {
  if (role.custom) {
    return /*#__PURE__*/React.createElement("div", {
      className: "ox-gradient-ring",
      style: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        padding: 20,
        borderRadius: "var(--radius-lg)",
        background: "var(--card)",
        minHeight: 220,
        textAlign: "center"
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: 40,
        height: 40,
        borderRadius: "var(--radius-md)",
        background: "color-mix(in oklch, var(--violet-500) 16%, transparent)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--ox-violet-bright)"
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "plus",
      size: 20
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: "var(--font-sans)",
        fontSize: 15,
        fontWeight: 600
      }
    }, "New custom role"), /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 12,
        color: "var(--muted-foreground)",
        maxWidth: 200
      }
    }, role.desc), /*#__PURE__*/React.createElement(Button, {
      variant: "outline",
      size: "sm",
      style: {
        marginTop: 4
      }
    }, "Create role"));
  }
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 12,
      padding: 16,
      borderRadius: "var(--radius-lg)",
      background: "var(--card)",
      border: "1px solid var(--border)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "flex-start",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 34,
      height: 34,
      borderRadius: "var(--radius-md)",
      border: "1px solid var(--border)",
      background: "var(--background-2)",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      color: role.color
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: role.icon,
    size: 17
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: 15,
      fontWeight: 600
    }
  }, role.name), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "var(--muted-foreground)"
    }
  }, role.members, " ", role.members === 1 ? "member" : "members")), /*#__PURE__*/React.createElement(Badge, {
    variant: "neutral",
    mono: true
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "lock",
    size: 10,
    style: {
      marginRight: 3
    }
  }), "System")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      lineHeight: 1.5,
      color: "var(--muted-foreground)"
    }
  }, role.desc), /*#__PURE__*/React.createElement("div", null, role.perms.map(p => /*#__PURE__*/React.createElement(PermRow, {
    key: p[0],
    label: p[0],
    state: p[1]
  }))));
}
function AccessScreen() {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "0 24px 24px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
      gap: 14
    }
  }, ROLES.map(r => /*#__PURE__*/React.createElement(RoleCard, {
    key: r.name,
    role: r
  }))));
}
window.AccessScreen = AccessScreen;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/AccessScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/App.jsx
try { (() => {
function App() {
  const [authed, setAuthed] = React.useState(false);
  const [active, setActive] = React.useState("ask");
  const [kTab, setKTab] = React.useState("graph");
  const [theme, setTheme] = React.useState("dark");
  const toggleTheme = () => setTheme(t => t === "light" ? "dark" : "light");
  function frame(children) {
    return /*#__PURE__*/React.createElement("div", {
      className: theme === "light" ? "light" : "",
      style: {
        height: "100%"
      }
    }, children);
  }
  if (!authed) return frame(/*#__PURE__*/React.createElement(window.LoginScreen, {
    onAuth: () => setAuthed(true),
    theme: theme,
    onToggleTheme: toggleTheme
  }));
  let title, subtitle, tabs, body;
  if (active === "ask") {
    body = /*#__PURE__*/React.createElement(window.AskScreen, null);
  } else if (active === "knowledge") {
    title = "Knowledge";
    subtitle = "Typed entities and permission-checked relationships across your sources.";
    tabs = /*#__PURE__*/React.createElement(window.KnowledgeTabs, {
      tab: kTab,
      setTab: setKTab
    });
    body = /*#__PURE__*/React.createElement(window.KnowledgeScreen, null);
  } else if (active === "access") {
    title = "Access";
    subtitle = "Roles and policies that scope what every principal — human or agent — can reach.";
    body = /*#__PURE__*/React.createElement(window.AccessScreen, null);
  } else {
    title = active.charAt(0).toUpperCase() + active.slice(1);
    subtitle = "This surface is part of the Oxagen kit — explore Ask, Knowledge and Access for the full build-out.";
    body = /*#__PURE__*/React.createElement("div", {
      style: {
        display: "grid",
        placeItems: "center",
        height: "100%",
        padding: 40,
        textAlign: "center"
      }
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--muted-foreground)"
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "construction",
      size: 28
    })), /*#__PURE__*/React.createElement("p", {
      style: {
        color: "var(--muted-foreground)",
        fontSize: 13,
        marginTop: 10
      }
    }, title, " \u2014 wired in the full product.")));
  }

  // Ask is full-bleed (its own header-less chat layout)
  if (active === "ask") {
    return frame(/*#__PURE__*/React.createElement(window.Shell, {
      active: active,
      onNavigate: setActive,
      theme: theme,
      onToggleTheme: toggleTheme
    }, body));
  }
  return frame(/*#__PURE__*/React.createElement(window.Shell, {
    active: active,
    onNavigate: setActive,
    title: title,
    subtitle: subtitle,
    tabs: tabs,
    theme: theme,
    onToggleTheme: toggleTheme
  }, body));
}
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(/*#__PURE__*/React.createElement(App, null));
// Convert any lucide placeholders rendered before the font script settled.
setTimeout(() => {
  try {
    window.lucide && window.lucide.createIcons();
  } catch (e) {}
}, 300);
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/App.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/AskScreen.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const {
  Button,
  Badge,
  Textarea,
  NodeChip
} = window.OxagenDesignSystem_2dfe15;
const FM = typeof window !== "undefined" && window.Motion || null;
const MDiv = FM ? FM.motion.div : "div";
function Bubble({
  role,
  children,
  animate = true
}) {
  const isUser = role === "user";
  const motionProps = FM && animate ? {
    initial: {
      opacity: 0,
      y: 10
    },
    animate: {
      opacity: 1,
      y: 0
    },
    transition: {
      type: "spring",
      stiffness: 380,
      damping: 30
    }
  } : {};
  return /*#__PURE__*/React.createElement(MDiv, _extends({}, motionProps, {
    style: {
      display: "flex",
      justifyContent: isUser ? "flex-end" : "flex-start"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: "82%",
      padding: isUser ? "10px 14px" : "12px 16px",
      borderRadius: isUser ? "16px 16px 4px 16px" : "var(--radius-lg)",
      fontSize: 13.5,
      lineHeight: 1.6,
      background: isUser ? "var(--accent)" : "var(--card)",
      color: isUser ? "var(--accent-foreground)" : "var(--card-foreground)",
      border: isUser ? "1px solid var(--border)" : "1px solid var(--border)",
      boxShadow: "var(--shadow-sm)"
    }
  }, children));
}
function Thinking() {
  const dot = d => ({
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "var(--ox-violet-bright)"
  });
  const anim = FM ? {
    animate: {
      opacity: [0.3, 1, 0.3],
      y: [0, -2, 0]
    }
  } : {};
  return /*#__PURE__*/React.createElement(Bubble, {
    role: "assistant",
    animate: false
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "flex",
      gap: 4
    }
  }, [0, 1, 2].map(i => /*#__PURE__*/React.createElement(MDiv, _extends({
    key: i
  }, FM ? {
    animate: {
      opacity: [0.3, 1, 0.3],
      y: [0, -2, 0]
    },
    transition: {
      duration: 0.9,
      repeat: Infinity,
      delay: i * 0.15
    }
  } : {}, {
    style: dot()
  })))), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12.5,
      color: "var(--muted-foreground)"
    }
  }, "Scoping retrieval to your grants\u2026")));
}
function TimelineItem({
  tone = "done",
  icon,
  children
}) {
  const dot = tone === "running" ? "var(--ox-violet-bright)" : tone === "failed" ? "var(--destructive)" : "var(--cyan-400)";
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 12,
      position: "relative"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 24,
      height: 24,
      borderRadius: "50%",
      background: "var(--background-2)",
      border: "1px solid var(--border)",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      color: dot
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: icon,
    size: 13
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1,
      width: 1,
      background: "var(--border)",
      marginTop: 2,
      minHeight: 8
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      paddingBottom: 14
    }
  }, children));
}
function ToolCard() {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-md)",
      background: "var(--background-2)",
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "9px 12px",
      borderBottom: "1px solid var(--border)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--cyan-400)"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "database",
    size: 15
  })), /*#__PURE__*/React.createElement("code", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 12,
      fontWeight: 600,
      color: "var(--foreground)"
    }
  }, "graph.query"), /*#__PURE__*/React.createElement(Badge, {
    variant: "risk-low",
    style: {
      marginLeft: 4
    }
  }, "low risk"), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: "auto",
      fontFamily: "var(--font-mono)",
      fontSize: 11,
      color: "var(--muted-foreground)"
    }
  }, "318ms"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "#67d182"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "check",
    size: 15
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 12,
      display: "flex",
      flexDirection: "column",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("code", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 11.5,
      color: "var(--muted-foreground)",
      lineHeight: 1.5
    }
  }, "MATCH (u:User)-[:CAN_READ]->(d:Document) WHERE u.id = \"prn_8fa21c\""), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexWrap: "wrap",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement(NodeChip, {
    kind: "document",
    label: "Auth spec",
    id: "doc_41be"
  }), /*#__PURE__*/React.createElement(NodeChip, {
    kind: "document",
    label: "RLS policy",
    id: "doc_9c2a"
  }), /*#__PURE__*/React.createElement(NodeChip, {
    kind: "document",
    label: "OXA-1515",
    id: "doc_77fd"
  }))));
}
function Thread({
  messages,
  thinking
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 16,
      maxWidth: 760,
      margin: "0 auto",
      padding: "20px 24px 8px"
    }
  }, messages.map((m, i) => m.role === "user" ? /*#__PURE__*/React.createElement(Bubble, {
    key: i,
    role: "user"
  }, m.text) : /*#__PURE__*/React.createElement(Bubble, {
    key: i,
    role: "assistant"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 7,
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 18,
      height: 18,
      borderRadius: "50%",
      background: "var(--grad-cosmos)",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "sparkles",
    size: 11,
    color: "#fff"
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      fontWeight: 600
    }
  }, "Oxagen agent"), /*#__PURE__*/React.createElement(Badge, {
    variant: "neutral",
    mono: true,
    style: {
      marginLeft: 2
    }
  }, "claude-sonnet")), m.reasoning && /*#__PURE__*/React.createElement(TimelineItem, {
    tone: "done",
    icon: "brain"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      color: "var(--muted-foreground)"
    }
  }, "Thought for 4s \xB7 scoped retrieval to caller's read grants")), m.tool && /*#__PURE__*/React.createElement(TimelineItem, {
    tone: "done",
    icon: "wrench"
  }, /*#__PURE__*/React.createElement(ToolCard, null)), /*#__PURE__*/React.createElement("div", {
    style: {
      paddingLeft: m.tool || m.reasoning ? 36 : 0
    }
  }, m.text))), thinking && /*#__PURE__*/React.createElement(Thinking, null));
}
function Composer({
  onSend
}) {
  const [val, setVal] = React.useState("");
  const [gen, setGen] = React.useState(null);
  function submit() {
    if (!val.trim()) return;
    onSend(val.trim());
    setVal("");
  }
  const toolBtn = (name, key, label) => {
    const on = gen === key;
    return /*#__PURE__*/React.createElement("button", {
      onClick: () => setGen(on ? null : key),
      title: label,
      style: {
        width: 32,
        height: 32,
        borderRadius: "var(--radius-md)",
        border: "1px solid transparent",
        background: on ? "color-mix(in oklch, var(--primary) 18%, transparent)" : "transparent",
        color: on ? "var(--ox-violet-bright)" : "var(--muted-foreground)",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center"
      }
    }, /*#__PURE__*/React.createElement(Icon, {
      name: name,
      size: 16
    }));
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 760,
      margin: "0 auto",
      width: "100%",
      padding: "8px 24px 20px",
      boxSizing: "border-box"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: "var(--card)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-xl)",
      padding: 12,
      boxShadow: "var(--shadow-md)"
    }
  }, /*#__PURE__*/React.createElement("textarea", {
    value: val,
    onChange: e => setVal(e.target.value),
    onKeyDown: e => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
    },
    placeholder: "Ask anything \u2014 the agent only sees what you're allowed to\u2026",
    rows: 2,
    style: {
      width: "100%",
      border: "none",
      outline: "none",
      resize: "none",
      background: "transparent",
      color: "var(--foreground)",
      fontFamily: "var(--font-sans)",
      fontSize: 13.5,
      lineHeight: 1.55,
      padding: "2px 4px"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 4,
      marginTop: 6
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      height: 32,
      padding: "0 10px",
      borderRadius: "var(--radius-md)",
      border: "1px solid var(--border)",
      background: "var(--background-2)",
      color: "var(--foreground)",
      fontSize: 12.5,
      fontWeight: 500,
      cursor: "pointer",
      fontFamily: "var(--font-sans)"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "zap",
    size: 14,
    color: "var(--ox-violet-bright)"
  }), " Fast ", /*#__PURE__*/React.createElement(Icon, {
    name: "chevron-down",
    size: 13
  })), /*#__PURE__*/React.createElement("button", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      height: 32,
      padding: "0 10px",
      borderRadius: "var(--radius-md)",
      border: "1px solid transparent",
      background: "transparent",
      color: "var(--muted-foreground)",
      fontSize: 12.5,
      cursor: "pointer",
      fontFamily: "var(--font-sans)"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "brain",
    size: 14
  }), " Medium"), toolBtn("image", "image", "Generate image"), toolBtn("video", "video", "Generate video"), /*#__PURE__*/React.createElement("button", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      height: 32,
      padding: "0 10px",
      borderRadius: "var(--radius-md)",
      border: "1px solid transparent",
      background: "transparent",
      color: "var(--muted-foreground)",
      fontSize: 12.5,
      cursor: "pointer",
      fontFamily: "var(--font-sans)"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "plug",
    size: 14
  }), " 3 MCP"), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: "auto"
    }
  }, /*#__PURE__*/React.createElement(Button, {
    variant: "gradient",
    size: "sm",
    onClick: submit,
    startIcon: /*#__PURE__*/React.createElement(Icon, {
      name: "arrow-up",
      size: 15,
      color: "#fff"
    })
  }, "Send")))), /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: "center",
      marginTop: 8,
      fontSize: 11,
      color: "var(--muted-foreground)"
    }
  }, "Retrieval is RBAC-enforced \xB7 \u2318\u21B5 to send"));
}
function AskScreen() {
  const scrollRef = React.useRef(null);
  const [messages, setMessages] = React.useState([{
    role: "user",
    text: "What does the auth service need to know about row-level security?"
  }, {
    role: "assistant",
    reasoning: true,
    tool: true,
    text: /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 13.5,
        lineHeight: 1.65
      }
    }, "Row-level security (RLS) scopes every query to the caller's tenant. The auth service should set ", /*#__PURE__*/React.createElement("code", {
      style: {
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        background: "var(--muted)",
        padding: "1px 5px",
        borderRadius: 4
      }
    }, "app.tenant_id"), " before any read, and use ", /*#__PURE__*/React.createElement("code", {
      style: {
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        background: "var(--muted)",
        padding: "1px 5px",
        borderRadius: 4
      }
    }, "withSystemDb"), " only for pre-tenant identity resolution (see OXA-1515).")
  }]);
  const [thinking, setThinking] = React.useState(false);
  function send(text) {
    setMessages(m => [...m, {
      role: "user",
      text
    }]);
    setThinking(true);
    setTimeout(() => {
      setThinking(false);
      setMessages(m => [...m, {
        role: "assistant",
        reasoning: true,
        tool: false,
        text: "Pulling scoped context from the graph — only nodes you can read are in view. Here's what I found across the connected sources."
      }]);
    }, 1100);
  }
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, thinking]);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      height: "100%"
    }
  }, /*#__PURE__*/React.createElement("div", {
    ref: scrollRef,
    style: {
      flex: 1,
      minHeight: 0,
      overflowY: "auto"
    }
  }, /*#__PURE__*/React.createElement(Thread, {
    messages: messages,
    thinking: thinking
  })), /*#__PURE__*/React.createElement(Composer, {
    onSend: send
  }));
}
window.AskScreen = AskScreen;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/AskScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/KnowledgeScreen.jsx
try { (() => {
const {
  Button,
  Badge,
  Tabs,
  NodeChip,
  ConfidenceBar
} = window.OxagenDesignSystem_2dfe15;
const KIND_COLOR = {
  user: "#45dcef",
  document: "#9b7bff",
  service: "#67d182",
  policy: "#ea5a82",
  resource: "#ffbe63"
};
const NODES = [{
  id: "u1",
  x: 150,
  y: 110,
  r: 13,
  kind: "user",
  label: "Ada L."
}, {
  id: "d1",
  x: 300,
  y: 60,
  r: 11,
  kind: "document",
  label: "Auth spec"
}, {
  id: "d2",
  x: 320,
  y: 175,
  r: 11,
  kind: "document",
  label: "RLS policy"
}, {
  id: "s1",
  x: 110,
  y: 240,
  r: 12,
  kind: "service",
  label: "GitHub"
}, {
  id: "p1",
  x: 250,
  y: 285,
  r: 10,
  kind: "policy",
  label: "read:eng"
}, {
  id: "d3",
  x: 450,
  y: 120,
  r: 10,
  kind: "document",
  label: "OXA-1515"
}, {
  id: "r1",
  x: 470,
  y: 250,
  r: 10,
  kind: "resource",
  label: "vault"
}, {
  id: "u2",
  x: 60,
  y: 130,
  r: 10,
  kind: "user",
  label: "Grace H."
}];
const EDGES = [["u1", "d1"], ["u1", "d2"], ["u1", "s1"], ["d2", "p1"], ["d1", "d3"], ["d2", "d3"], ["s1", "p1"], ["d3", "r1"], ["d2", "r1"], ["u2", "u1"], ["u2", "s1"]];
function GraphCanvas() {
  const byId = Object.fromEntries(NODES.map(n => [n.id, n]));
  return /*#__PURE__*/React.createElement("div", {
    className: "ox-grid-dots",
    style: {
      position: "relative",
      flex: 1,
      minWidth: 0,
      borderRadius: "var(--radius-lg)",
      border: "1px solid var(--border)",
      background: "var(--background)",
      overflow: "hidden",
      minHeight: 360
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: 0,
      background: "radial-gradient(60% 60% at 40% 30%, color-mix(in oklch, var(--violet-600) 18%, transparent), transparent 70%)"
    }
  }), /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 540 360",
    style: {
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%"
    }
  }, /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("linearGradient", {
    id: "edgeg",
    x1: "0",
    y1: "0",
    x2: "1",
    y2: "1"
  }, /*#__PURE__*/React.createElement("stop", {
    offset: "0",
    stopColor: "#45dcef",
    stopOpacity: "0.5"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "1",
    stopColor: "#9b7bff",
    stopOpacity: "0.5"
  }))), EDGES.map(([a, b], i) => /*#__PURE__*/React.createElement("line", {
    key: i,
    x1: byId[a].x,
    y1: byId[a].y,
    x2: byId[b].x,
    y2: byId[b].y,
    stroke: "url(#edgeg)",
    strokeWidth: "1.2"
  })), NODES.map(n => /*#__PURE__*/React.createElement("g", {
    key: n.id
  }, /*#__PURE__*/React.createElement("circle", {
    cx: n.x,
    cy: n.y,
    r: n.r + 9,
    fill: KIND_COLOR[n.kind],
    opacity: "0.16"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: n.x,
    cy: n.y,
    r: n.r,
    fill: KIND_COLOR[n.kind],
    stroke: "var(--background)",
    strokeWidth: "2"
  }), /*#__PURE__*/React.createElement("text", {
    x: n.x,
    y: n.y + n.r + 14,
    textAnchor: "middle",
    fontFamily: "var(--font-sans)",
    fontSize: "9.5",
    fill: "var(--muted-foreground)"
  }, n.label)))), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      left: 14,
      top: 14,
      display: "flex",
      gap: 7,
      flexWrap: "wrap"
    }
  }, Object.entries(KIND_COLOR).map(([k, c]) => /*#__PURE__*/React.createElement("span", {
    key: k,
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 5,
      fontFamily: "var(--font-sans)",
      fontSize: 10,
      fontWeight: 500,
      color: "var(--muted-foreground)",
      background: "color-mix(in oklch, var(--background) 70%, transparent)",
      padding: "2px 7px",
      borderRadius: 999,
      border: "1px solid var(--border)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 7,
      height: 7,
      borderRadius: "50%",
      background: c
    }
  }), k))), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      right: 14,
      bottom: 14,
      display: "flex",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("button", {
    style: {
      width: 30,
      height: 30,
      borderRadius: "var(--radius-md)",
      border: "1px solid var(--border)",
      background: "var(--card)",
      color: "var(--foreground)",
      cursor: "pointer",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "plus",
    size: 15
  })), /*#__PURE__*/React.createElement("button", {
    style: {
      width: 30,
      height: 30,
      borderRadius: "var(--radius-md)",
      border: "1px solid var(--border)",
      background: "var(--card)",
      color: "var(--foreground)",
      cursor: "pointer",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "minus",
    size: 15
  })), /*#__PURE__*/React.createElement("button", {
    style: {
      width: 30,
      height: 30,
      borderRadius: "var(--radius-md)",
      border: "1px solid var(--border)",
      background: "var(--card)",
      color: "var(--foreground)",
      cursor: "pointer",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "maximize",
    size: 14
  }))));
}
function Stat({
  value,
  label,
  accent
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      padding: "12px 14px",
      background: "var(--card)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-lg)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: 22,
      fontWeight: 700,
      color: accent || "var(--foreground)",
      fontVariantNumeric: "tabular-nums"
    }
  }, value), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: 10,
      fontWeight: 600,
      letterSpacing: "0.1em",
      textTransform: "uppercase",
      color: "var(--muted-foreground)",
      marginTop: 2
    }
  }, label));
}
function PendingEdge({
  rel,
  from,
  to,
  fromKind,
  toKind,
  score,
  connector
}) {
  const [resolved, setResolved] = React.useState(null);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 12,
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-md)",
      background: "var(--background-2)",
      opacity: resolved ? 0.5 : 1,
      transition: "opacity var(--motion-base)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 7,
      flexWrap: "wrap",
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement(NodeChip, {
    kind: fromKind,
    id: from
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted-foreground)"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "arrow-right",
    size: 13
  })), /*#__PURE__*/React.createElement("code", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 10,
      fontWeight: 700,
      color: "var(--ox-violet-bright)",
      background: "color-mix(in oklch, var(--violet-500) 16%, transparent)",
      borderRadius: 4,
      padding: "2px 6px"
    }
  }, rel), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted-foreground)"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "arrow-right",
    size: 13
  })), /*#__PURE__*/React.createElement(NodeChip, {
    kind: toKind,
    id: to
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 12
    }
  }, /*#__PURE__*/React.createElement(ConfidenceBar, {
    score: score,
    width: 90
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: 11,
      color: "var(--muted-foreground)"
    }
  }, "via ", connector), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: "auto",
      display: "flex",
      gap: 6
    }
  }, resolved ? /*#__PURE__*/React.createElement(Badge, {
    variant: resolved === "approved" ? "success" : "neutral",
    dot: true
  }, resolved) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Button, {
    size: "sm",
    variant: "ghost",
    onClick: () => setResolved("denied")
  }, "Deny"), /*#__PURE__*/React.createElement(Button, {
    size: "sm",
    variant: "primary",
    onClick: () => setResolved("approved"),
    startIcon: /*#__PURE__*/React.createElement(Icon, {
      name: "check",
      size: 14,
      color: "#fff"
    })
  }, "Approve")))));
}
function KnowledgeScreen() {
  const [tab, setTab] = React.useState("graph");
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "0 24px 24px"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 12,
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement(Stat, {
    value: "18.2k",
    label: "Edges",
    accent: "var(--cyan-300)"
  }), /*#__PURE__*/React.createElement(Stat, {
    value: "4.1k",
    label: "Nodes"
  }), /*#__PURE__*/React.createElement(Stat, {
    value: "6",
    label: "Sources"
  }), /*#__PURE__*/React.createElement(Stat, {
    value: "23",
    label: "Pending",
    accent: "#ffbe63"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: 18,
      alignItems: "stretch",
      flexWrap: "wrap"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: "1 1 340px",
      display: "flex",
      flexDirection: "column",
      minWidth: 320
    }
  }, /*#__PURE__*/React.createElement(GraphCanvas, null)), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: "1 1 320px",
      minWidth: 300,
      display: "flex",
      flexDirection: "column",
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--ox-violet-bright)"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "git-pull-request-arrow",
    size: 16
  })), /*#__PURE__*/React.createElement("h3", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: 15,
      fontWeight: 600,
      margin: 0
    }
  }, "Pending inferences"), /*#__PURE__*/React.createElement(Badge, {
    variant: "warning",
    style: {
      marginLeft: "auto"
    }
  }, "23 to review")), /*#__PURE__*/React.createElement(PendingEdge, {
    rel: "CAN_READ",
    from: "prn_8fa21c",
    to: "doc_41be09",
    fromKind: "user",
    toKind: "document",
    score: 0.92,
    connector: "github"
  }), /*#__PURE__*/React.createElement(PendingEdge, {
    rel: "OWNS",
    from: "svc_github",
    to: "doc_9c2a1f",
    fromKind: "service",
    toKind: "document",
    score: 0.74,
    connector: "github"
  }), /*#__PURE__*/React.createElement(PendingEdge, {
    rel: "GOVERNS",
    from: "pol_read_eng",
    to: "doc_77fd03",
    fromKind: "policy",
    toKind: "document",
    score: 0.58,
    connector: "okta"
  }))));
}
window.KnowledgeScreen = KnowledgeScreen;
window.KnowledgeTabs = function ({
  tab,
  setTab
}) {
  return /*#__PURE__*/React.createElement(Tabs, {
    value: tab,
    onChange: setTab,
    items: [{
      value: "sources",
      label: "Sources",
      icon: /*#__PURE__*/React.createElement(Icon, {
        name: "plug",
        size: 14
      }),
      badge: 6
    }, {
      value: "graph",
      label: "Graph",
      icon: /*#__PURE__*/React.createElement(Icon, {
        name: "git-fork",
        size: 14
      })
    }, {
      value: "memories",
      label: "Memories",
      icon: /*#__PURE__*/React.createElement(Icon, {
        name: "brain",
        size: 14
      }),
      badge: 12
    }]
  });
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/KnowledgeScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/LoginScreen.jsx
try { (() => {
const {
  Button,
  Input,
  OxagenLogo
} = window.OxagenDesignSystem_2dfe15;
function OAuthBtn({
  icon,
  label
}) {
  return /*#__PURE__*/React.createElement("button", {
    style: {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 9,
      width: "100%",
      height: 40,
      borderRadius: "var(--radius-md)",
      border: "1px solid var(--border-strong)",
      background: "var(--background-2)",
      color: "var(--foreground)",
      fontFamily: "var(--font-sans)",
      fontSize: 13,
      fontWeight: 500,
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: icon,
    size: 16
  }), " ", label);
}
function LoginScreen({
  onAuth,
  theme,
  onToggleTheme
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "ox-mesh",
    style: {
      position: "relative",
      height: "100%",
      display: "grid",
      placeItems: "center",
      padding: 24,
      boxSizing: "border-box"
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onToggleTheme,
    "aria-label": "Toggle theme",
    style: {
      position: "absolute",
      top: 18,
      right: 18,
      width: 34,
      height: 34,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: "var(--radius-md)",
      border: "1px solid var(--border)",
      background: "var(--card)",
      color: "var(--muted-foreground)",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: theme === "light" ? "moon" : "sun",
    size: 16
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative",
      width: "100%",
      maxWidth: 380
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      justifyContent: "center",
      marginBottom: 22
    }
  }, /*#__PURE__*/React.createElement(OxagenLogo, {
    variant: "vertical",
    size: 40
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      background: "var(--card)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-xl)",
      padding: 26,
      boxShadow: "var(--shadow-xl)"
    }
  }, /*#__PURE__*/React.createElement("h1", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: 22,
      fontWeight: 600,
      letterSpacing: "-0.02em",
      margin: 0,
      textAlign: "center"
    }
  }, "Welcome back"), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: "6px 0 20px",
      textAlign: "center",
      fontSize: 13,
      color: "var(--muted-foreground)"
    }
  }, "Sign in to your Oxagen workspace."), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 9
    }
  }, /*#__PURE__*/React.createElement(OAuthBtn, {
    icon: "github",
    label: "Continue with GitHub"
  }), /*#__PURE__*/React.createElement(OAuthBtn, {
    icon: "chrome",
    label: "Continue with Google"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 12,
      margin: "18px 0"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      height: 1,
      background: "var(--border)"
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: 10,
      fontWeight: 600,
      letterSpacing: "0.14em",
      textTransform: "uppercase",
      color: "var(--muted-foreground)"
    }
  }, "Or"), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      height: 1,
      background: "var(--border)"
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    style: {
      display: "block",
      fontSize: 12,
      fontWeight: 500,
      marginBottom: 5
    }
  }, "Email"), /*#__PURE__*/React.createElement(Input, {
    defaultValue: "mac@acme.dev",
    startIcon: /*#__PURE__*/React.createElement(Icon, {
      name: "mail",
      size: 14
    })
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    style: {
      display: "block",
      fontSize: 12,
      fontWeight: 500,
      marginBottom: 5
    }
  }, "Password"), /*#__PURE__*/React.createElement(Input, {
    type: "password",
    defaultValue: "hunter2hunter2",
    startIcon: /*#__PURE__*/React.createElement(Icon, {
      name: "lock",
      size: 14
    })
  })), /*#__PURE__*/React.createElement(Button, {
    variant: "gradient",
    size: "lg",
    onClick: onAuth,
    style: {
      width: "100%",
      marginTop: 4
    }
  }, "Sign in")), /*#__PURE__*/React.createElement("p", {
    style: {
      margin: "16px 0 0",
      textAlign: "center",
      fontSize: 12.5,
      color: "var(--muted-foreground)"
    }
  }, "Don't have an account? ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--ox-violet-bright)",
      cursor: "pointer",
      fontWeight: 500
    }
  }, "Sign up"))), /*#__PURE__*/React.createElement("p", {
    style: {
      textAlign: "center",
      marginTop: 16,
      fontFamily: "var(--font-sans)",
      fontSize: 11,
      color: "var(--muted-foreground)",
      letterSpacing: "0.02em"
    }
  }, "SOC 2 Type II \xB7 SSO/SCIM \xB7 RBAC-enforced retrieval")));
}
window.LoginScreen = LoginScreen;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/LoginScreen.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/Shell.jsx
try { (() => {
const {
  OxagenLogo,
  Avatar,
  Badge
} = window.OxagenDesignSystem_2dfe15;
const NAV = [{
  id: "ask",
  label: "Ask",
  icon: "message-square",
  group: "primary"
}, {
  id: "knowledge",
  label: "Knowledge",
  icon: "book-open",
  group: "primary"
}, {
  id: "automation",
  label: "Automation",
  icon: "workflow",
  group: "primary"
}, {
  id: "activity",
  label: "Activity",
  icon: "activity",
  group: "primary"
}, {
  id: "studio",
  label: "Studio",
  icon: "sparkles",
  group: "tools"
}, {
  id: "access",
  label: "Access",
  icon: "key-round",
  group: "tools"
}];
function NavItem({
  item,
  active,
  onClick
}) {
  const [hover, setHover] = React.useState(false);
  return /*#__PURE__*/React.createElement("button", {
    onClick: onClick,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      width: "100%",
      padding: "8px 10px",
      borderRadius: "var(--radius-md)",
      border: "none",
      cursor: "pointer",
      textAlign: "left",
      fontFamily: "var(--font-sans)",
      fontSize: 13,
      fontWeight: active ? 600 : 500,
      color: active ? "var(--foreground)" : hover ? "var(--foreground)" : "var(--muted-foreground)",
      background: active ? "var(--sidebar-accent)" : hover ? "color-mix(in oklch, var(--sidebar-accent) 60%, transparent)" : "transparent",
      position: "relative",
      transition: "background var(--motion-micro), color var(--motion-micro)"
    }
  }, active && /*#__PURE__*/React.createElement("span", {
    style: {
      position: "absolute",
      left: 0,
      top: 8,
      bottom: 8,
      width: 3,
      borderRadius: 3,
      background: "var(--grad-sunset)"
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      color: active ? "var(--ox-violet-bright)" : "inherit"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: item.icon,
    size: 17
  })), item.label);
}
function GroupLabel({
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      padding: "2px 12px 6px",
      fontFamily: "var(--font-sans)",
      fontSize: 10,
      fontWeight: 600,
      letterSpacing: "0.14em",
      textTransform: "uppercase",
      color: "var(--muted-foreground)"
    }
  }, children);
}
function Shell({
  active,
  onNavigate,
  title,
  subtitle,
  tabs,
  children,
  theme,
  onToggleTheme
}) {
  const primary = NAV.filter(n => n.group === "primary");
  const tools = NAV.filter(n => n.group === "tools");
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      height: "100%",
      padding: 12,
      gap: 12,
      background: "var(--background)",
      boxSizing: "border-box"
    }
  }, /*#__PURE__*/React.createElement("aside", {
    style: {
      width: 232,
      flexShrink: 0,
      display: "flex",
      flexDirection: "column",
      background: "var(--sidebar)",
      border: "1px solid var(--sidebar-border)",
      borderRadius: "var(--radius-xl)",
      boxShadow: "var(--shadow-md)",
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      height: 56,
      display: "flex",
      alignItems: "center",
      padding: "0 14px"
    }
  }, /*#__PURE__*/React.createElement(OxagenLogo, {
    variant: "horizontal",
    size: 22
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      padding: 8,
      display: "flex",
      flexDirection: "column",
      gap: 2,
      overflowY: "auto"
    }
  }, /*#__PURE__*/React.createElement(GroupLabel, null, "Workspace"), primary.map(n => /*#__PURE__*/React.createElement(NavItem, {
    key: n.id,
    item: n,
    active: active === n.id,
    onClick: () => onNavigate(n.id)
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 1,
      background: "var(--sidebar-border)",
      margin: "8px 10px"
    }
  }), /*#__PURE__*/React.createElement(GroupLabel, null, "Tools"), tools.map(n => /*#__PURE__*/React.createElement(NavItem, {
    key: n.id,
    item: n,
    active: active === n.id,
    onClick: () => onNavigate(n.id)
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 8,
      borderTop: "1px solid var(--sidebar-border)",
      display: "flex",
      flexDirection: "column",
      gap: 4
    }
  }, /*#__PURE__*/React.createElement(NavItem, {
    item: {
      id: "settings",
      label: "Settings",
      icon: "settings"
    },
    active: active === "settings",
    onClick: () => onNavigate("settings")
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 9,
      padding: "6px 8px",
      borderRadius: "var(--radius-md)"
    }
  }, /*#__PURE__*/React.createElement(Avatar, {
    name: "Mac Anderson",
    size: 28
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12.5,
      fontWeight: 600,
      color: "var(--foreground)",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis"
    }
  }, "Mac Anderson"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: "var(--muted-foreground)"
    }
  }, "Owner")), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: "auto",
      color: "var(--muted-foreground)"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "chevrons-up-down",
    size: 14
  }))))), /*#__PURE__*/React.createElement("main", {
    style: {
      flex: 1,
      minWidth: 0,
      display: "flex",
      flexDirection: "column",
      background: "var(--background-2)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius-xl)",
      overflow: "hidden"
    }
  }, /*#__PURE__*/React.createElement("header", {
    style: {
      height: 56,
      flexShrink: 0,
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "0 18px",
      borderBottom: "1px solid var(--border)"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      color: "var(--muted-foreground)",
      fontSize: 13
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "layout-grid",
    size: 15
  }), /*#__PURE__*/React.createElement("span", null, "acme"), /*#__PURE__*/React.createElement("span", {
    style: {
      opacity: 0.5
    }
  }, "/"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--foreground)",
      fontWeight: 500
    }
  }, "engineering"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted-foreground)"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "chevron-down",
    size: 14
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: "auto",
      display: "flex",
      alignItems: "center",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      alignItems: "center",
      gap: 6,
      padding: "5px 10px",
      borderRadius: "var(--radius-full)",
      border: "1px solid var(--border)",
      background: "var(--card)",
      fontFamily: "var(--font-sans)",
      fontWeight: 500,
      fontSize: 12,
      fontVariantNumeric: "tabular-nums",
      color: "var(--foreground)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: "50%",
      background: "#67d182",
      boxShadow: "0 0 6px #67d182"
    }
  }), "$248.10"), /*#__PURE__*/React.createElement("button", {
    onClick: onToggleTheme,
    "aria-label": "Toggle theme",
    style: {
      display: "inline-flex",
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: "var(--radius-md)",
      border: "1px solid var(--border)",
      background: "var(--card)",
      color: "var(--muted-foreground)",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: theme === "light" ? "moon" : "sun",
    size: 16
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--muted-foreground)",
      cursor: "pointer"
    }
  }, /*#__PURE__*/React.createElement(Icon, {
    name: "bell",
    size: 17
  })))), (title || tabs) && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: tabs ? "20px 24px 0" : "20px 24px",
      flexShrink: 0
    }
  }, title && /*#__PURE__*/React.createElement("h1", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: 24,
      fontWeight: 600,
      letterSpacing: "-0.02em",
      margin: 0
    }
  }, title), subtitle && /*#__PURE__*/React.createElement("p", {
    style: {
      margin: "5px 0 0",
      color: "var(--muted-foreground)",
      fontSize: 13.5
    }
  }, subtitle), tabs && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 16
    }
  }, tabs)), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      overflowY: "auto"
    }
  }, children)));
}
window.Shell = Shell;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/Shell.jsx", error: String((e && e.message) || e) }); }

// ui_kits/app/icons.jsx
try { (() => {
/*
 * Icon — renders a Lucide icon (the icon set the Oxagen app uses, lucide-react).
 * Loaded from the lucide UMD CDN; each Icon converts its own <i data-lucide>
 * into an inline <svg> that inherits currentColor, so re-renders stay safe.
 */
function Icon({
  name,
  size = 16,
  strokeWidth = 2,
  color,
  style
}) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || !window.lucide) return;
    el.innerHTML = "";
    const i = document.createElement("i");
    i.setAttribute("data-lucide", name);
    el.appendChild(i);
    try {
      window.lucide.createIcons({
        attrs: {
          width: size,
          height: size,
          "stroke-width": strokeWidth
        },
        nameAttr: "data-lucide"
      });
    } catch (e) {/* lucide not ready */}
  });
  return /*#__PURE__*/React.createElement("span", {
    ref: ref,
    "aria-hidden": "true",
    style: {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      color: color || "inherit",
      width: size,
      height: size,
      flexShrink: 0,
      ...style
    }
  });
}
window.Icon = Icon;
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/app/icons.jsx", error: String((e && e.message) || e) }); }

__ds_ns.ConfidenceBar = __ds_scope.ConfidenceBar;

__ds_ns.NodeChip = __ds_scope.NodeChip;

__ds_ns.OxagenLogo = __ds_scope.OxagenLogo;

__ds_ns.CopyButton = __ds_scope.CopyButton;

__ds_ns.CodeBlock = __ds_scope.CodeBlock;

__ds_ns.CodeTabs = __ds_scope.CodeTabs;

__ds_ns.LangIcon = __ds_scope.LangIcon;

__ds_ns.Avatar = __ds_scope.Avatar;

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.CardHeader = __ds_scope.CardHeader;

__ds_ns.CardTitle = __ds_scope.CardTitle;

__ds_ns.CardDescription = __ds_scope.CardDescription;

__ds_ns.CardBody = __ds_scope.CardBody;

__ds_ns.CardFooter = __ds_scope.CardFooter;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.Switch = __ds_scope.Switch;

__ds_ns.Tabs = __ds_scope.Tabs;

__ds_ns.Textarea = __ds_scope.Textarea;

__ds_ns.Dialog = __ds_scope.Dialog;

__ds_ns.Drawer = __ds_scope.Drawer;

__ds_ns.ToastProvider = __ds_scope.ToastProvider;

__ds_ns.OnboardingWizard = __ds_scope.OnboardingWizard;

__ds_ns.Stepper = __ds_scope.Stepper;

__ds_ns.Collapse = __ds_scope.Collapse;

__ds_ns.MainNav = __ds_scope.MainNav;

__ds_ns.Panel = __ds_scope.Panel;

__ds_ns.Sidebar = __ds_scope.Sidebar;

__ds_ns.AnimatePresence = __ds_scope.AnimatePresence;

__ds_ns.MotionConfig = __ds_scope.MotionConfig;

__ds_ns.SPRING = __ds_scope.SPRING;

__ds_ns.BOUNCE = __ds_scope.BOUNCE;

__ds_ns.EASE_ENTRY = __ds_scope.EASE_ENTRY;

__ds_ns.EASE_EXIT = __ds_scope.EASE_EXIT;

})();
