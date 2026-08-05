export const pierrePrettyScrollbarCss = `
:host {
  --diffs-scrollbar-gutter-override: 10px;
}

[data-code] {
  scrollbar-gutter: auto;
}

[data-code]::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

[data-code]::-webkit-scrollbar-button {
  display: none;
  width: 0;
  height: 0;
}

[data-code]::-webkit-scrollbar-track {
  background: transparent;
}

[data-code]::-webkit-scrollbar-thumb {
  background-color: transparent;
  background-clip: content-box;
  border: 3px solid transparent;
  border-radius: 9999px;
}

:host(:hover) [data-code]::-webkit-scrollbar-thumb,
:host(:focus-within) [data-code]::-webkit-scrollbar-thumb {
  background-color: var(--scrollbar-thumb, rgb(100 116 139 / 55%));
}

[data-code]::-webkit-scrollbar-thumb:hover,
[data-code]::-webkit-scrollbar-thumb:active {
  background-color: var(--scrollbar-thumb-hover, rgb(71 85 105 / 85%));
}

[data-code]::-webkit-scrollbar-corner {
  background: transparent;
}

:host(:hover) {
  --scrollbar-hover-repaint: ;
}

@media (hover: none) {
  [data-code]::-webkit-scrollbar-thumb {
    background-color: var(--scrollbar-thumb, rgb(100 116 139 / 55%));
  }
}
`;
