'use strict';

const LANGUAGE_OPTIONS = [
  { value: 'auto', label: 'Auto (match source)', promptName: null },
  { value: 'vi', label: 'Tiếng Việt (Vietnamese)', promptName: 'Vietnamese' },
  { value: 'en', label: 'English', promptName: 'English' },
  { value: 'ja', label: '日本語 (Japanese)', promptName: 'Japanese' },
  { value: 'zh', label: '中文 (Chinese)', promptName: 'Chinese' },
  { value: 'ko', label: '한국어 (Korean)', promptName: 'Korean' },
  { value: 'fr', label: 'Français (French)', promptName: 'French' },
  { value: 'de', label: 'Deutsch (German)', promptName: 'German' },
  { value: 'es', label: 'Español (Spanish)', promptName: 'Spanish' },
];

const SUPPORTED_LANGUAGES = new Set(LANGUAGE_OPTIONS.map(option => option.value));
const isSupportedLanguage = value => typeof value === 'string' && SUPPORTED_LANGUAGES.has(value);
const languagePromptName = value => LANGUAGE_OPTIONS.find(option => option.value === value)?.promptName ?? null;

module.exports = { LANGUAGE_OPTIONS, isSupportedLanguage, languagePromptName };
