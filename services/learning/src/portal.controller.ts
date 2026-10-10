import { Body, Controller, Get, Inject, Param, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentContext, Permissions, StudentScoped } from '@palladium/service-kit';
import type { RequestContext } from '@palladium/contracts';
import type { Response } from 'express';
import { LearningService } from './learning-service.js';
import { MAX_UPLOAD_BYTES, type UploadedResourceFile } from './uploads.js';
function portalLinks<T>(value: T): T {
    if (Array.isArray(value))
        return value.map(v => portalLinks(v)) as T;
    if (value && typeof value === 'object') {
        const output: Record<string, unknown> = {};
        for (const [key, v] of Object.entries(value))
            output[key] = key === 'downloadUrl' && typeof v === 'string' ? v.replace('/v1/resources/', '/v1/portal/resources/') : portalLinks(v);
        return output as T;
    }
    return value;
}
@StudentScoped()
@Controller('v1/portal')
export class PortalLearningController {
    constructor(
    @Inject(LearningService)
    private readonly learning: LearningService) {
    }
    @Get('assignments')
    @Permissions('learning.read')
    async list(
    @CurrentContext()
    ctx: RequestContext, 
    @Query()
    query: unknown) {
        return portalLinks(await this.learning.listAssignments(ctx, query));
    }
    @Get('assignments/:id')
    @Permissions('learning.read')
    async get(
    @CurrentContext()
    ctx: RequestContext, 
    @Param('id')
    id: string) {
        return portalLinks(await this.learning.getAssignment(ctx, id));
    }
    @Post('assignments/:id/submit')
    @Permissions('learning.write')
    async submit(
    @CurrentContext()
    ctx: RequestContext, 
    @Param('id')
    id: string, 
    @Body()
    body: unknown) {
        return portalLinks(await this.learning.submit(ctx, id, body));
    }
    @Post('assignments/:id/submission-upload')
    @Permissions('learning.write')
    @UseInterceptors(FileInterceptor('file', {
        limits: {
            fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 1, parts: 2, fieldSize: 4096
        }
    }))
    async upload(
    @CurrentContext()
    ctx: RequestContext, 
    @Param('id')
    id: string, 
    @Body()
    body: unknown, 
    @UploadedFile()
    file: UploadedResourceFile | undefined) {
        return portalLinks(await this.learning.uploadSubmission(ctx, id, body, file));
    }
    @Get('resources')
    @Permissions('learning.read')
    async resources(
    @CurrentContext()
    ctx: RequestContext, 
    @Query()
    query: unknown) {
        return portalLinks(await this.learning.listResources(ctx, query, true));
    }
    @Get('resources/capabilities')
    @Permissions('learning.read')
    capabilities() {
        return {
            item: {
                googleDocs: {
                    referenceLinks: true, createDocument: false, availability: 'external_sharing', reason: 'Select an existing Google document link. Google controls document sharing; document creation is unavailable.'
                }, privateUploads: {
                    supported: true, maxBytes: MAX_UPLOAD_BYTES
                }
            }
        };
    }
    @Get('resources/:id')
    @Permissions('learning.read')
    async resource(
    @CurrentContext()
    ctx: RequestContext, 
    @Param('id')
    id: string) {
        return portalLinks(await this.learning.getResource(ctx, id));
    }
    @Get('resources/:id/download')
    @Permissions('learning.read')
    download(
    @CurrentContext()
    ctx: RequestContext, 
    @Param('id')
    id: string, 
    @Res({
        passthrough: true
    })
    response: Response) {
        return this.learning.downloadResource(ctx, id, response);
    }
}
