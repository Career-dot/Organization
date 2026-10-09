## Implementation Complete ✓

### Modified File
- `frontend/src/pages/dashboard/EmployeeProfile.jsx` (139 lines, was 100)

### Key Changes Made

1. **State Management** (line 24)
   - Added `const [roleExperiences, setRoleExperiences] = useState({})`
   - Stores role → years mapping: `{ "Backend Developer": 2, "Full Stack Developer": 1 }`

2. **Data Loading** (line 44)
   - Added `setRoleExperiences(data.jobPreferences?.preferredRoleExperience ?? {})` in useEffect
   - Safely loads existing experience data or defaults to empty object
   - Backward compatible: existing profiles without experience work fine

3. **Role Removal Cleanup** (lines 58-65)
   - Updated `removeRole()` to also delete role's experience entry
   - Prevents orphaned experience data

4. **Experience Update Handler** (lines 67-73)
   - Added `updateRoleExperience(role, value)` function
   - Validates: integer, min 0, max 80
   - Handles blank input as empty string (unsaved)
   - Updates only the specified role's experience

5. **Save Payload** (lines 82-85)
   - Modified jobPreferences save to include:
     ```javascript
     await saveCandidateProfileSection("jobPreferences", { 
       preferredRole: form.preferredRoles,
       preferredRoleExperience: roleExperiences,
     });
     ```

6. **UI Display** (lines 111-130)
   - Replaced simple role badge with:
     - Role name
     - Number input (min=0, max=80)
     - "years" label
     - Remove button
   - Maintains existing styling pattern
   - Uses `gap-4` instead of `gap-2` for better spacing

### Storage Structure

```json
{
  "jobPreferences": {
    "preferredRole": ["Backend Developer", "Full Stack Developer"],
    "preferredRoleExperience": {
      "Backend Developer": 2,
      "Full Stack Developer": 1
    }
  }
}
```

### Behavior Summary

- **Add Role**: New role appears with blank experience input
- **Remove Role**: Role and its experience are both removed
- **Update Experience**: Only that role's value changes, others unaffected
- **Validation**: Whole numbers 0-80, blank allowed
- **Loading**: Existing experience loaded if present, otherwise blank
- **Saving**: Both roles array and experience object saved together

### Scope Verification

✓ ONLY `EmployeeProfile.jsx` modified  
✗ No backend files changed  
✗ No Prisma/schema changes  
✗ No migration created  
✗ No database changes  
✗ No auth/role-switching changes  
✗ No other frontend files changed  

### Backward Compatibility

✓ Existing profiles load correctly (experience defaults to `{}`)  
✓ Existing roles display with blank experience inputs  
✓ No migration required  
✓ No data loss  

### NOT Implemented (Out of Scope)

✗ Career relevance scoring  
✗ Role-skill matching  
✗ Charts/visualization  
✗ Skill verification weighting  
✗ CareerRole taxonomy integration  

**Implementation complete and ready for testing.**