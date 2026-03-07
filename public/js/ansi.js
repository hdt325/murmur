/**
 * ANSI escape code to HTML converter.
 * Converts terminal output with ANSI color codes into styled HTML spans.
 */

const ANSI_COLORS = [
  "#000", "#c23621", "#25bc24", "#adad27", "#492ee1", "#d338d3", "#33bbc8", "#cbcccd",
  "#818383", "#fc391f", "#31e722", "#eaec23", "#5833ff", "#f935f8", "#14f0f0", "#e9ebeb",
];

function brighten(hex) {
  const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + 40);
  const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + 40);
  const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + 40);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/**
 * Convert ANSI-escaped text to HTML with styled spans.
 * Supports: bold, dim, italic, underline, 8/16/256/true-color foreground and background.
 */
export function ansiToHtml(text) {
  let out = "";
  let fg = null, bg = null, bold = false, dim = false, italic = false, underline = false;
  let spanOpen = false;

  function openSpan() {
    const styles = [];
    if (fg) {
      let color = fg;
      if (bold && /^#/.test(color)) color = brighten(color);
      styles.push("color:" + color);
    }
    if (bg) styles.push("background:" + bg);
    if (bold) styles.push("font-weight:bold");
    if (dim) styles.push("opacity:0.6");
    if (italic) styles.push("font-style:italic");
    if (underline) styles.push("text-decoration:underline");
    if (styles.length) {
      out += '<span style="' + styles.join(";") + '">';
      spanOpen = true;
    }
  }

  function closeSpan() {
    if (spanOpen) { out += "</span>"; spanOpen = false; }
  }

  let i = 0;
  while (i < text.length) {
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      const end = text.indexOf("m", i + 2);
      if (end === -1) { i++; continue; }
      closeSpan();
      const codes = text.slice(i + 2, end).split(";").map(Number);
      for (let ci = 0; ci < codes.length; ci++) {
        const c = codes[ci];
        if (c === 0) { fg = bg = null; bold = dim = italic = underline = false; }
        else if (c === 1) bold = true;
        else if (c === 2) dim = true;
        else if (c === 3) italic = true;
        else if (c === 4) underline = true;
        else if (c === 22) { bold = false; dim = false; }
        else if (c === 23) italic = false;
        else if (c === 24) underline = false;
        else if (c >= 30 && c <= 37) fg = ANSI_COLORS[c - 30];
        else if (c === 38 && codes[ci + 1] === 5) { fg = ansi256(codes[ci + 2]); ci += 2; }
        else if (c === 38 && codes[ci + 1] === 2) { fg = `rgb(${codes[ci + 2]},${codes[ci + 3]},${codes[ci + 4]})`; ci += 4; }
        else if (c === 39) fg = null;
        else if (c >= 40 && c <= 47) bg = ANSI_COLORS[c - 40];
        else if (c === 48 && codes[ci + 1] === 5) { bg = ansi256(codes[ci + 2]); ci += 2; }
        else if (c === 48 && codes[ci + 1] === 2) { bg = `rgb(${codes[ci + 2]},${codes[ci + 3]},${codes[ci + 4]})`; ci += 4; }
        else if (c === 49) bg = null;
        else if (c >= 90 && c <= 97) fg = ANSI_COLORS[c - 90 + 8];
        else if (c >= 100 && c <= 107) bg = ANSI_COLORS[c - 100 + 8];
      }
      openSpan();
      i = end + 1;
    } else if (text[i] === "\n") {
      closeSpan();
      out += "\n";
      openSpan();
      i++;
    } else if (text[i] === "<") {
      out += "&lt;"; i++;
    } else if (text[i] === ">") {
      out += "&gt;"; i++;
    } else if (text[i] === "&") {
      out += "&amp;"; i++;
    } else {
      out += text[i]; i++;
    }
  }
  closeSpan();
  return out;
}

function ansi256(n) {
  if (n < 16) return ANSI_COLORS[n];
  if (n >= 232) { const g = 8 + (n - 232) * 10; return `rgb(${g},${g},${g})`; }
  n -= 16;
  const r = Math.floor(n / 36) * 51;
  const g = Math.floor((n % 36) / 6) * 51;
  const b = (n % 6) * 51;
  return `rgb(${r},${g},${b})`;
}
