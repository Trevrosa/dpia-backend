const { defineConfig, globalIgnores } = require("eslint/config");

const globals = require("globals");
const tsParser = require("@typescript-eslint/parser");
const typescriptEslint = require("@typescript-eslint/eslint-plugin");
const js = require("@eslint/js");

const { FlatCompat } = require("@eslint/eslintrc");

const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all,
});

module.exports = defineConfig([
    {
        languageOptions: {
            globals: {
                ...globals.browser,
            },

            parser: tsParser,
            ecmaVersion: "latest",
            sourceType: "module",
            parserOptions: {},
        },

        extends: compat.extends(
            "eslint:recommended",
            "plugin:@typescript-eslint/recommended",
            "plugin:prettier/recommended",
        ),

        plugins: {
            "@typescript-eslint": typescriptEslint,
        },

        rules: {
            "@typescript-eslint/no-explicit-any": "warn",
            "no-console": "warn",
        },
    },
    globalIgnores(["**/dist", "**/node_modules"]),
]);
