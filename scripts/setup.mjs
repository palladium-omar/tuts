import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFile, access } from 'node:fs/promises';
try{await access(new URL('../.env',import.meta.url));console.log('.env already exists; preserving it.');process.exit(0);}catch{}
const {privateKey,publicKey}=generateKeyPairSync('ed25519',{privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
const token=()=>randomBytes(24).toString('hex');
const fields={NODE_ENV:'development',PUBLIC_APP_URL:'http://localhost:3000',PUBLIC_GATEWAY_URL:'http://localhost:8080',NEXT_PUBLIC_GATEWAY_URL:'http://localhost:8080',POSTGRES_PASSWORD:token(),RABBITMQ_USER:'palladium',RABBITMQ_PASSWORD:token(),CONTEXT_PRIVATE_KEY:privateKey.replace(/\n/g,'\\n'),CONTEXT_PUBLIC_KEY:publicKey.replace(/\n/g,'\\n'),PLATFORM_INTERNAL_SECRET:token(),BETTER_AUTH_SECRET:token(),PAYMENT_ENCRYPTION_KEY:randomBytes(32).toString('base64'),ALLOW_SANDBOX_PAYMENTS:'true'};
for(const name of ['platform','clients','scheduling','learning','billing','payments','notifications'])fields[`${name.toUpperCase()}_DB_PASSWORD`]=token();
await writeFile(new URL('../.env',import.meta.url),Object.entries(fields).map(([k,v])=>`${k}="${v}"`).join('\n')+'\n',{mode:0o600});
console.log('Generated private local development settings in ignored .env. No live payment accounts are connected.');
