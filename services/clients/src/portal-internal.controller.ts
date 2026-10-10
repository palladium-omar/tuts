import { Body, Controller, Headers, Inject, Post, ForbiddenException, ServiceUnavailableException, ConflictException } from '@nestjs/common';
import { Database, Public, parseBody } from '@palladium/service-kit';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { lockContacts } from './contact-store.js';
import { listRelatedContacts, requireStudent } from './student-identity.js';
const schema = z.object({ businessId: z.uuid(), studentId: z.uuid(), protect: z.boolean() }).strict();
@Controller('internal')
export class PortalInternalController {
    constructor(
    @Inject(Database)
    private readonly db: Database) { }
    @Public()
    @Post('portal-students')
    async student(
    @Headers('x-portal-internal-secret')
    supplied: string | undefined, 
    @Body()
    body: unknown) {
        const expected = process.env.PORTAL_INTERNAL_SECRET;
        if (!expected)
            throw new ServiceUnavailableException('Portal validation is unavailable');
        const a = Buffer.from(supplied ?? ''), b = Buffer.from(expected);
        if (a.length !== b.length || !timingSafeEqual(a, b))
            throw new ForbiddenException('Invalid internal authorization');
        const input = parseBody(schema, body);
        return this.db.withTenant(input.businessId, async (tx) => {
            await lockContacts(tx, input.businessId);
            const student = await requireStudent(tx, input.studentId);
            if (input.protect) {
                if (student.id !== input.studentId)
                    throw new ConflictException('Merged student cannot receive a grant');
                if (student.status === 'inactive')
                    throw new ConflictException('Inactive student cannot receive a grant');
                await tx.query('UPDATE clients SET portal_protected_at=COALESCE(portal_protected_at,now()) WHERE id=$1', [student.id]);
            }
            return { item: { id: student.id, displayName: student.display_name, revision: student.revision, portalProtected: input.protect || Boolean(student.portal_protected_at), contacts: await listRelatedContacts(tx, student.id) } };
        });
    }
}
