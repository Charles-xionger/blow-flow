export type SkillOwnerScope = Readonly<{ ownerId: string }>;

// The app has no authentication yet. This stable local identity is the explicit
// replacement seam for a future authenticated user identity.
export const currentLocalOwnerId = 'local-user-v1';
export const currentLocalOwner: SkillOwnerScope = Object.freeze({ ownerId: currentLocalOwnerId });
