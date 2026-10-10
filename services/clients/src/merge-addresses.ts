import { ConflictException } from '@nestjs/common';

export type AddressKind = 'email' | 'phone';
export type MergeAddress = { value: string; label: string };
export type PrimaryAddresses = Partial<Record<AddressKind, string>>;
export type RetainedAddresses = Partial<Record<AddressKind, string[]>>;
export const addressKey = (kind: AddressKind, value: string) =>
    kind === 'email' ? value.trim().toLowerCase() : value.replace(/[^0-9+]/g, '');

// Explicit retention is separate from primary selection. Missing decisions for
// multiple addresses reject the merge, including requests from older dialogs.
export function selectMergeAddresses(kind: AddressKind, available: MergeAddress[], options: {
    retained?: string[]; primary?: string; preferred?: string; legacyChoice?: string;
}) {
    let retained = options.retained;
    if (retained === undefined) {
        if (options.legacyChoice !== undefined) retained = [options.legacyChoice];
        else if (available.length > 1)
            throw new ConflictException(`Choose which ${kind === 'email' ? 'email addresses' : 'phone numbers'} to keep; refresh the merge preview`);
        else retained = available.map(address => address.value);
    }
    if (available.length && !retained.length)
        throw new ConflictException(`Select at least one ${kind} to keep`);
    if (retained.length > 20)
        throw new ConflictException(`Keep at most 20 ${kind === 'email' ? 'email addresses' : 'phone numbers'}`);
    const keys = new Set(retained.map(value => addressKey(kind, value)));
    if (keys.size !== retained.length || [...keys].some(key => !available.some(address => addressKey(kind, address.value) === key)))
        throw new ConflictException(`Choose distinct ${kind} values from the merge preview`);
    const addresses = available.filter(address => keys.has(addressKey(kind, address.value)));
    const selectedPrimary = options.primary ? addresses.find(address => addressKey(kind, address.value) === addressKey(kind, options.primary!)) : undefined;
    if (options.primary && !selectedPrimary)
        throw new ConflictException(`Choose a primary ${kind} from the addresses you are keeping`);
    const preferred = options.preferred ? addresses.find(address => addressKey(kind, address.value) === addressKey(kind, options.preferred!)) : undefined;
    return { addresses, primary: selectedPrimary?.value ?? preferred?.value ?? addresses[0]?.value ?? null };
}
