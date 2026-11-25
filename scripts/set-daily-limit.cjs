'use strict';

const fs = require('node:fs');
const path = require('node:path');

const rawArg = process.argv[2];
const limit = Number(rawArg);

if (!rawArg || !Number.isInteger(limit) || limit < 1 || limit > 10000) {
  console.error('Cách dùng: node scripts/set-daily-limit.cjs <so_luot_moi>');
  console.error('Ví dụ:   node scripts/set-daily-limit.cjs 50');
  process.exit(1);
}

const root = path.resolve(__dirname, '..');

function updateFile(relPath, pattern, replacement) {
  const fullPath = path.join(root, relPath);
  if (!fs.existsSync(fullPath)) return { path: relPath, status: 'skipped (not found)' };
  const original = fs.readFileSync(fullPath, 'utf8');
  if (!pattern.test(original)) {
    throw new Error(`Không tìm thấy cấu hình daily limit trong ${relPath}`);
  }
  const updated = original.replace(pattern, replacement);
  if (updated !== original) {
    fs.writeFileSync(fullPath, updated, 'utf8');
    return { path: relPath, status: 'updated' };
  }
  return { path: relPath, status: 'unchanged' };
}

const results = [
  updateFile('js/config.js', /(dailyRequestLimit:\s*)\d+/, `$1${limit}`),
  updateFile('index.html', /(<span id="quota-count">0\s*\/\s*)\d+(<\/span>)/, `$1${limit}$2`),
  updateFile('apps-script/OpenRouter.gs', /(const\s+OPENROUTER_DAILY_LIMIT\s*=\s*)\d+;/, `$1${limit};`)
];

console.log(`Đã cập nhật giới hạn Daily requests thành ${limit} lượt/ngày:`);
results.forEach((item) => {
  console.log(`- ${item.path}: ${item.status}`);
});
if (results.some((r) => r.path === 'apps-script/OpenRouter.gs' && r.status === 'updated')) {
  console.log('\nLưu ý: Nhớ copy apps-script/OpenRouter.gs lên Google Apps Script và Deploy > New version để áp dụng ở server.');
}
