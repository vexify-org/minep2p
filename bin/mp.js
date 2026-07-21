#!/usr/bin/env node
// © Vexify 2026 All Rights Reserved.
try {
    require('../cli.js');
} catch (err) {
    console.error('FATAL ERROR:', err.message);
    console.error(err.stack);
    process.exit(1);
}
