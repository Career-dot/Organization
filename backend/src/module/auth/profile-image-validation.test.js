const test = require('node:test');
const assert = require('node:assert/strict');

const { accountSettingsSchema } = require('./auth.validation');

test('accepts relative profile image paths used by file uploads', () => {
  const result = accountSettingsSchema.safeParse({
    profileImage: '/api/files/123/view',
  });

  assert.equal(result.success, true, result.error?.issues?.[0]?.message ?? 'unexpected validation failure');
});

test('accepts absolute profile image URLs', () => {
  const result = accountSettingsSchema.safeParse({
    profileImage: 'https://example.com/avatar.png',
  });

  assert.equal(result.success, true, result.error?.issues?.[0]?.message ?? 'unexpected validation failure');
});

test('accepts versioned profile image paths returned by file uploads', () => {
  const result = accountSettingsSchema.safeParse({
    profileImage: '/api/files/cmtscjz5z0005u2t0c6e00dul/view?v=1757315825203',
  });

  assert.equal(result.success, true, result.error?.issues?.[0]?.message ?? 'unexpected validation failure');
});
