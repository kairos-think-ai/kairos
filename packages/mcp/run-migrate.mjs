import { runMigrations } from './src/migrate.js';
const result = await runMigrations();
console.log(JSON.stringify(result, null, 2));
