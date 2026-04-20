import { PrismaClient, CourtType } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Borrando base de datos limpia...');
  await prisma.waitlist.deleteMany();
  await prisma.walletTransaction.deleteMany();
  await prisma.reservationPayment.deleteMany();
  await prisma.reservation.deleteMany();
  await prisma.court.deleteMany();
  await prisma.user.deleteMany();

  console.log('Seeding Users...');
  const admin = await prisma.user.create({
    data: {
      email: 'admin@padel.com',
      password: 'hashed-password-simulated', // Normalmente bcrypt.hash
      firstName: 'Admin',
      lastName: 'Padel',
      role: 'ADMIN',
      walletBalance: 0,
    },
  });

  const user1 = await prisma.user.create({
    data: {
      email: 'user1@padel.com',
      password: 'hashed-password-simulated',
      firstName: 'Juan',
      lastName: 'Pérez',
      role: 'USER',
      walletBalance: 5000, // 50 EUR en céntimos
    },
  });

  const user2 = await prisma.user.create({
    data: {
      email: 'user2@padel.com',
      password: 'hashed-password-simulated',
      firstName: 'María',
      lastName: 'Gómez',
      role: 'USER',
      walletBalance: 2500, // 25 EUR en céntimos
    },
  });

  console.log('Seeding Courts...');
  await prisma.court.createMany({
    data: [
      {
        name: 'Pista 1 - Cristal',
        type: CourtType.INDOOR,
        capacity: 4,
        pricePerHour: 2000, // 20 EUR
      },
      {
        name: 'Pista 2 - Cristal Pro',
        type: CourtType.INDOOR,
        capacity: 4,
        pricePerHour: 2500, // 25 EUR
      },
      {
        name: 'Pista 3 - Muro',
        type: CourtType.OUTDOOR,
        capacity: 4,
        pricePerHour: 1500, // 15 EUR
      },
      {
        name: 'Pista 4 - Muro Clásica',
        type: CourtType.OUTDOOR,
        capacity: 4,
        pricePerHour: 1000, // 10 EUR
      },
    ]
  });

  console.log('Seed completado con éxito! ✅');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
