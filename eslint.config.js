import babelParser from '@babel/eslint-parser';
import reactHooks from 'eslint-plugin-react-hooks';

const uiImports =
  '^(react|react-dom|react-i18next|i18next|lucide-react|maplibre-gl)(/|$)|^@radix-ui/';

function boundary(files, forbiddenLayers, message) {
  return {
    files,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: `(^|/)(${forbiddenLayers})(/|$)|(^|/)(App|main)(\\.|$)|${uiImports}`,
              message,
            },
          ],
        },
      ],
      // Keep these dependencies static so the import restrictions cannot be bypassed.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression, TSImportType, CallExpression[callee.name="require"]',
          message: 'Use static imports in this layer so module boundaries can be checked.',
        },
      ],
    },
  };
}

export default [
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          babelrc: false,
          configFile: false,
          parserOpts: { plugins: ['typescript', 'jsx'] },
        },
      },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  boundary(
    ['src/core/**/*.{ts,tsx}'],
    'app|components|features|device|workers|i18n',
    'Core logic must stay independent of the application, UI, storage, workers and device transport.',
  ),
  boundary(
    ['src/device/**/*.{ts,tsx}'],
    'app|components|features|core|workers|i18n',
    'Device transport must stay independent of application/UI logic and the RTE core codec.',
  ),
  boundary(
    ['src/workers/**/*.{ts,tsx}'],
    'app|components|features|device|i18n',
    'Route workers may use core logic, but must stay independent of the application, UI and device transport.',
  ),
];
