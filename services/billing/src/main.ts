import 'reflect-metadata';
import { fileURLToPath } from 'node:url';
import { bootstrap } from '@palladium/service-kit';
import { BillingController, BillingService } from './billing.js';
bootstrap({name:'billing',port:4005,controllers:[BillingController],providers:[BillingService],migrationsDir:fileURLToPath(new URL('../migrations',import.meta.url)),entitlement:'billing'}).catch(error=>{console.error(error);process.exit(1);});
