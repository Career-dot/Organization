-- Preserve the currently active profile image for each user, and remove stale duplicate PROFILE_IMAGE rows created by older logic.
WITH ranked_profile_images AS (
    SELECT
        sf.id,
        sf."ownerId",
        ROW_NUMBER() OVER (
            PARTITION BY sf."ownerId"
            ORDER BY
                CASE
                    WHEN u."profileImage" = '/api/files/' || sf.id || '/view' THEN 0
                    ELSE 1
                END,
                sf."createdAt" DESC,
                sf.id DESC
        ) AS row_num
    FROM "StoredFile" sf
    INNER JOIN "User" u ON u.id = sf."ownerId"
    WHERE sf.category = 'PROFILE_IMAGE'
      AND sf."ownerType" = 'EMPLOYEE'
)
DELETE FROM "StoredFile" sf
USING ranked_profile_images r
WHERE sf.id = r.id
  AND r.row_num > 1;

-- Enforce the invariant: one employee user can have at most one PROFILE_IMAGE StoredFile row.
CREATE UNIQUE INDEX "StoredFile_profile_image_one_per_user"
ON "StoredFile" ("ownerId")
WHERE "category" = 'PROFILE_IMAGE' AND "ownerType" = 'EMPLOYEE';
