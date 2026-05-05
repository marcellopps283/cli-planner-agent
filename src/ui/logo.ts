import { Text } from "ink";
import React, { createElement } from "react";

const h = createElement;

export function OpenCodeLogo(): React.ReactElement {
  return h(
    Text,
    { bold: true },
    h(Text, { color: "blue" }, "blue"),
    h(Text, { color: "white" }, "print"),
  );
}
