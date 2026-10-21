import base from './playwright.config';
export default { ...base, use: { ...base.use, browserName: 'chromium' as const, channel: 'chrome' } };
