export type AssignmentRow = {
    revision: number;
    id: string;
    business_id: string;
    client_id: string;
    title: string;
    description: string;
    due_at: Date | null;
    status: string;
    submission_text: string | null;
    submission_url: string | null;
    submitted_at: Date | null;
    feedback: string | null;
    reviewed_at: Date | null;
    created_at: Date;
    updated_at: Date;
    resource_ids?: string[];
    submission_resource_ids?: string[];
};
export type ResourceRow = {
    revision: number;
    id: string;
    business_id: string;
    client_id: string;
    title: string;
    purpose: string;
    submission_assignment_id: string | null;
    kind: string;
    url: string | null;
    file_name: string | null;
    mime_type: string | null;
    size_bytes: string | null;
    storage_status: string;
    storage_key?: string | null;
    created_at: Date;
};
export function assignmentView(row: AssignmentRow) {
    return {
        id: row.id,
        revision: row.revision,
        businessId: row.business_id,
        clientId: row.client_id,
        title: row.title,
        description: row.description,
        dueAt: row.due_at?.toISOString() ?? null,
        status: row.status,
        resourceIds: row.resource_ids ?? [],
        submissionResourceIds: row.submission_resource_ids ?? [],
        submissionText: row.submission_text,
        submissionUrl: row.submission_url,
        submittedAt: row.submitted_at?.toISOString() ?? null,
        feedback: row.feedback,
        reviewedAt: row.reviewed_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}
export function resourceView(row: ResourceRow) {
    return {
        id: row.id,
        revision: row.revision,
        businessId: row.business_id,
        clientId: row.client_id,
        title: row.title,
        kind: row.kind,
        purpose: row.purpose,
        assignmentId: row.submission_assignment_id,
        referenceProvider: row.kind === "google_doc" ? "google_docs" : null,
        sharingNotice: row.kind === "google_doc" ? "Google controls access to this document; saving this link does not change sharing." : null,
        url: row.url,
        fileName: row.file_name,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
        storageStatus: row.storage_status,
        downloadUrl: row.storage_status === "stored"
            ? `/v1/resources/${row.id}/download`
            : null,
        createdAt: row.created_at.toISOString(),
    };
}
