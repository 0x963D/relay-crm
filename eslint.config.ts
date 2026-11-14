import eslint from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

const PROCESS_ENV = {
  selector: "MemberExpression[object.name='process'][property.name='env']",
  message: "Read the environment in one place per process, so every other module takes values.",
};

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

const OWN_TRANSACTION = {
  selector: "MemberExpression[property.name='$transaction']",
  message: "Start every transaction with transact() from tx.ts, so it is SERIALIZABLE and retried.",
};

const LEADS_TABLE = {
  selector: "MemberExpression[object.name=/^(tx|db|prisma)$/][property.name='lead']",
  message: "Only leads.ts queries the leads table, so every lead read sits beside the scope rule.",
};

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
      // Vitest fixtures take their dependencies as an object pattern, which may be empty.
      "no-empty-pattern": ["error", { allowObjectPatternsAsParameters: true }],
      "no-restricted-syntax": ["error", PROCESS_ENV],
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: true },
      ],
    },
  },
  {
    ignores: ["**/test/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@relay/store/testing",
              message: "The test database fixture is for test files only.",
            },
          ],
        },
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
      "no-restricted-syntax": ["error", PROCESS_ENV, ...CLOCK_AND_RANDOMNESS],
    },
  },
  {
    files: ["packages/store/src/**"],
    rules: { "no-restricted-syntax": ["error", PROCESS_ENV, OWN_TRANSACTION, LEADS_TABLE] },
  },
  {
    files: ["packages/store/src/tx.ts"],
    rules: { "no-restricted-syntax": ["error", PROCESS_ENV, LEADS_TABLE] },
  },
  {
    files: ["packages/store/src/leads.ts"],
    rules: { "no-restricted-syntax": ["error", PROCESS_ENV, OWN_TRANSACTION] },
  },
  {
    files: ["packages/store/src/testing/**"],
    rules: { "no-restricted-syntax": ["error", OWN_TRANSACTION, LEADS_TABLE] },
  },
  {
    files: ["packages/store/prisma.config.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
);
