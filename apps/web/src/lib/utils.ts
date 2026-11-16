import { createCn } from "cn/config";
export const cn = createCn({
  extend: {
    theme: {
      spacing: [
        "tight",
        "compact",
        "related",
        "control",
        "group",
        "content",
        "section",
        "pane",
        "roomy",
        "form",
        "icon",
        "icon-small",
        "icon-large",
        "avatar",
        "avatar-large",
        "input",
        "touch",
      ],
      radius: ["slip", "control", "group", "surface"],
      shadow: ["control", "surface"],
    },
  },
});
