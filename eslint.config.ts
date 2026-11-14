import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

const CLOCK_AND_RANDOMNESS = [
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: "The domain never reads the clock. Take the time as an argument.",
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: "The domain never reads the clock. Take the time as an argument.",
  },
  {
    selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
    message: "The domain is deterministic. Take randomness as an argument.",
  },
];

export default defineConfig(
  globalIgnores(["**/node_modules/", "**/.next/", "**/generated/", "**/next-env.d.ts"]),
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: [
          "./tsconfig.json",
          "./packages/*/tsconfig.json",
          "./packages/*/tsconfig.test.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      eqeqeq: "error",
      "no-console": "error",
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: true },
      ],
    },
  },
  {
    files: ["packages/domain/src/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^[^.]",
              message: "The domain has no dependencies. Import only from its own files.",
            },
          ],
        },
      ],
      "no-restricted-syntax": ["error", ...CLOCK_AND_RANDOMNESS],
    },
  },
);
