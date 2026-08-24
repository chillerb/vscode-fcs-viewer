import typescriptEslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * Staged deliberately: `recommended` rather than `recommendedTypeChecked`.
 *
 * The rules that earn their place here are the ones that catch what actually
 * went wrong in review: no-unused-vars found the dead exports, and the
 * react-hooks rules cover dependency arrays in a webview whose entire render
 * path is memoised.
 *
 * `recommendedTypeChecked` was measured rather than guessed, and the result
 * was much smaller than expected -- around 30 real findings, none of them the
 * no-unsafe-* flood Plotly's untyped surface suggested, because the casts at
 * that boundary are explicit `as unknown as` rather than raw `any`. The
 * remainder is 22 redundant `!`, 3 template expressions and 2 needless
 * `async`. Its one big number, 170 no-floating-promises, is entirely
 * `describe`/`it` in node:test files and would need that rule off for
 * `src/test/**`. Enabling it needs `parserOptions.project` listing all three
 * tsconfigs, since the project service alone does not find the test files.
 * Left as a follow-up in TODO.md with those numbers attached.
 */
export default [
    {
        ignores: ["out/**", "dist/**", "node_modules/**", ".vscode-test/**"],
    },
    ...typescriptEslint.configs.recommended.map((c) => ({
        ...c,
        // The shipped configs target **/*.ts only; .tsx must parse too.
        files: ["**/*.ts", "**/*.tsx"],
    })),
    {
        // Both .ts and .tsx must be in the SAME config object as the parser,
        // otherwise flat config falls back to espree and JSX fails to parse.
        files: ["**/*.ts", "**/*.tsx"],

        plugins: {
            "@typescript-eslint": typescriptEslint.plugin,
        },

        languageOptions: {
            parser: typescriptEslint.parser,
            ecmaVersion: 2022,
            sourceType: "module",
        },

        rules: {
            "@typescript-eslint/naming-convention": ["warn", {
                selector: "import",
                format: ["camelCase", "PascalCase"],
            }],

            // Args are allowed to be unused when they document a signature;
            // an unused *binding* is the thing worth reporting.
            "@typescript-eslint/no-unused-vars": ["warn", {
                argsIgnorePattern: "^_",
                varsIgnorePattern: "^_",
                caughtErrors: "none",
            }],

            curly: "warn",
            eqeqeq: "warn",
            "no-throw-literal": "warn",
            semi: "warn",
        },
    },
    {
        // Hooks rules only where hooks exist. The webview is the whole reason
        // these matter: a missing dependency there shows up as a plot that
        // silently keeps rendering the previous sample.
        files: ["src/webview/**/*.ts", "src/webview/**/*.tsx"],
        ...reactHooks.configs.flat["recommended-latest"],
    },
];
