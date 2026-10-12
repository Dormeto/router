const write = (level) => (event, fields = {}) => console.log(JSON.stringify({ level, event, ...fields }));

export const logger = { info: write('info'), warn: write('warn'), error: write('error') };
