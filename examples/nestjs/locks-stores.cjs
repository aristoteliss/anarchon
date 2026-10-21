// The lock stores @nestjs/locks ships. `LockStore` itself is a TypeScript interface you implement.
const locks = require('@nestjs/locks');
const { version } = require('@nestjs/locks/package.json');

console.log(
  `@nestjs/locks ${version} ships these stores:`,
  Object.keys(locks).filter((name) => name.endsWith('Store')),
);
