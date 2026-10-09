const { PrismaClient } = require('D:/AI-Skill-Verification-Platform/backend/node_modules/@prisma/client');

const prisma = new PrismaClient();

async function checkOrgAdminAccounts() {
  try {
    console.log('=== QUERYING ORG_ADMIN ACCOUNTS ===\n');
    
    // Find all users with ORG_ADMIN role
    const orgAdminUsers = await prisma.user.findMany({
      where: {
        roles: {
          some: {
            role: {
              name: 'ORG_ADMIN'
            }
          }
        }
      },
      include: {
        roles: {
          include: {
            role: true
          }
        },
        employeeProfile: true,
        organizationMemberships: true,
        organizations: true
      }
    });
    
    console.log(`Found ${orgAdminUsers.length} ORG_ADMIN user(s):\n`);
    
    orgAdminUsers.forEach((user, index) => {
      console.log(`--- User ${index + 1} ---`);
      console.log(`ID: ${user.id}`);
      console.log(`Email: ${user.email}`);
      console.log(`Status: ${user.status}`);
      console.log(`Email Verified: ${user.emailVerified}`);
      console.log(`Global Roles: ${user.roles.map(r => r.role.name).join(', ')}`);
      console.log(`Has EmployeeProfile: ${!!user.employeeProfile}`);
      console.log(`Has Organization Memberships: ${user.organizationMemberships.length}`);
      console.log(`Owns Organizations: ${user.organizations.length}`);
      console.log('');
    });
    
    if (orgAdminUsers.length === 0) {
      console.log('No ORG_ADMIN users found in database.');
    }
    
    // Also check if there's a user with EMPLOYEE role but no ORG_ADMIN to understand the difference
    console.log('\n=== CHECKING FOR USER WITH EMPLOYEE ROLE ONLY ===\n');
    const candidateOnlyUsers = await prisma.user.findMany({
      where: {
        roles: {
          some: {
            role: {
              name: 'EMPLOYEE'
            }
          }
        },
        roles: {
          none: {
            role: {
              name: 'ORG_ADMIN'
            }
          }
        }
      },
      include: {
        roles: {
          include: {
            role: true
          }
        }
      },
      take: 3
    });
    
    console.log(`Found ${candidateOnlyUsers.length} candidate users (sample):`);
    candidateOnlyUsers.forEach((user, index) => {
      console.log(`  User ${index + 1}: ${user.email} - Roles: ${user.roles.map(r => r.role.name).join(', ')}`);
    });
    
  } catch (error) {
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
  } finally {
    await prisma.$disconnect();
  }
}

checkOrgAdminAccounts();
