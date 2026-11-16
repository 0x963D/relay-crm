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

const STORE_TESTING = {
  name: "@relay/store/testing",
  message: "The test database fixture is for test files only.",
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
          "./apps/*/tsconfig.json",
          "./apps/*/tsconfig.test.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      eqeqeq: "error",
      "no-console": "error",
      // Vitest fixtures take their dependencies as an object pattern, which may be empty.
      "no-empty-pattern": ["error", { allowObjectPatternsAsParameters: true }],
      "no-irregular-whitespace": ["error", { skipStrings: false, skipTemplates: false }],
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
      "no-restricted-imports": ["error", { paths: [STORE_TESTING] }],
    },
  },
  {
    files: ["apps/web/src/components/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            STORE_TESTING,
            { name: "cn", message: "Import cn from @/lib/utils, the shared control utility path." },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/web/src/app/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [STORE_TESTING],
          patterns: [
            {
              regex: "dev-actor",
              message: "Pages and routes get the actor from requireActor() in @/server/actor.ts.",
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
    files: [
      "packages/store/prisma.config.ts",
      "apps/web/src/server/env.ts",
      "apps/web/src/server/env-file.ts",
      "apps/web/test/production.prod.test.ts",
      "apps/web/test/browser/paths.ts",
    ],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    files: ["scripts/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    rules: { "no-console": "off" },
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
);
