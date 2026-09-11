import { pool } from "../config/db";

async function seed() {
  const client = await pool.connect();
  try {
    console.log("🌱 Resetting test data with realistic manufacturing factories...");
    await client.query("DELETE FROM mockups");
    await client.query("DELETE FROM quotations");
    await client.query("DELETE FROM chat_messages");
    await client.query("DELETE FROM chat_sessions");
    await client.query("DELETE FROM leads");
    await client.query("DELETE FROM discount_tiers");
    await client.query("DELETE FROM shipping_rates");
    await client.query("DELETE FROM products");
    await client.query("DELETE FROM factories WHERE email LIKE '%@testfactory.com'");

    console.log("🏭 Creating 3 Factories...");

    // Factory 1: Paper Cups & Food Packaging (Client's exact example)
    const factory1 = await client.query(`
      INSERT INTO factories (name, type, country, email, phone, logo_url)
      VALUES (
        'GreenCup Packaging Co.',
        'Paper Cups & Food Containers',
        'United States',
        'orders@greencup.testfactory.com',
        '+1-555-0111',
        'https://images.unsplash.com/photo-1514432324607-a09d9b4aefdd?w=300&h=300&fit=crop'
      ) RETURNING id;
    `);
    const f1 = factory1.rows[0].id;

    // Factory 2: Custom Boxes
    const factory2 = await client.query(`
      INSERT INTO factories (name, type, country, email, phone, logo_url)
      VALUES (
        'Apex Box & Packaging',
        'Corrugated & Rigid Boxes',
        'Canada',
        'sales@apexbox.testfactory.com',
        '+1-555-0222',
        'https://images.unsplash.com/photo-1530587191325-3db32d826c18?w=300&h=300&fit=crop'
      ) RETURNING id;
    `);
    const f2 = factory2.rows[0].id;

    // Factory 3: Custom Apparel
    const factory3 = await client.query(`
      INSERT INTO factories (name, type, country, email, phone, logo_url)
      VALUES (
        'Nova Merch & Textiles',
        'Garments & Merch',
        'United Kingdom',
        'hello@novamerch.testfactory.com',
        '+44-555-0333',
        'https://images.unsplash.com/photo-1529374255404-311a2a4f1fd9?w=300&h=300&fit=crop'
      ) RETURNING id;
    `);
    const f3 = factory3.rows[0].id;

    console.log("📦 Adding Products with Single/Double Wall & Real Specs...");

    // Products for Factory 1 (Paper Cups)
    await client.query(`
      INSERT INTO products (factory_id, name, category, wall_type, moq, price, lead_time, description, image_url) VALUES
      ('${f1}', 'Single Wall Paper Coffee Cup (12oz)', 'Paper Cups', 'single', 1000, 0.08, '10-14 days', 'Standard single wall coffee cup. Suitable for cold drinks or hot with sleeve.', 'https://images.unsplash.com/photo-1577937927133-66ef06acdf18?w=800'),
      ('${f1}', 'Double Wall Insulated Coffee Cup (12oz)', 'Paper Cups', 'double', 1000, 0.12, '10-14 days', 'Insulated double-wall cup. Heat-resistant, no sleeve needed. Premium matte touch.', 'https://images.unsplash.com/photo-1517256064527-09c73fc73e38?w=800'),
      ('${f1}', 'Biodegradable PLA Sip Lids (Fits 12/16oz)', 'Accessories', 'single', 1000, 0.03, '7-10 days', 'Compostable white/black sip-through lids for coffee cups.', 'https://images.unsplash.com/photo-1572442388796-11668a67e53d?w=800')
    `);

    // Products for Factory 2 (Boxes)
    await client.query(`
      INSERT INTO products (factory_id, name, category, wall_type, moq, price, lead_time, description, image_url) VALUES
      ('${f2}', 'Custom Printed Kraft Mailer Box', 'Mailer Boxes', 'single', 250, 1.25, '8-12 days', 'E-flute corrugated mailer box with full exterior custom printing.', 'https://images.unsplash.com/photo-1589939705384-5185137a7f0f?w=800'),
      ('${f2}', 'Heavy-Duty Double-Wall Shipping Carton', 'Shipping Boxes', 'double', 100, 3.40, '5-7 days', 'Double-wall corrugated cardboard for maximum protection during shipping.', 'https://images.unsplash.com/photo-1595341888016-a392ef81b7de?w=800')
    `);

    // Products for Factory 3 (Apparel)
    await client.query(`
      INSERT INTO products (factory_id, name, category, moq, price, lead_time, description, image_url) VALUES
      ('${f3}', '100% Organic Heavyweight T-Shirt (220 GSM)', 'Apparel', 50, 9.50, '7-10 days', 'Thick organic combed cotton t-shirt with custom screen print or embroidery.', 'https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=800'),
      ('${f3}', 'Oversized Streetwear Fleece Hoodie (400 GSM)', 'Apparel', 30, 26.00, '12-15 days', 'Premium heavyweight French terry fleece hoodie.', 'https://images.unsplash.com/photo-1556905055-8f358a7a47b2?w=800')
    `);

    // Seed discount tiers and shipping
    for (const fId of [f1, f2, f3]) {
      await client.query(`
        INSERT INTO discount_tiers (factory_id, min_quantity, discount_percent) VALUES
        ('${fId}', 2500, 5.00),
        ('${fId}', 5000, 10.00),
        ('${fId}', 10000, 15.00);
      `);

      await client.query(`
        INSERT INTO shipping_rates (factory_id, destination_country, rate_type, rate_value) VALUES
        ('${fId}', 'United States', 'flat', 80.00),
        ('${fId}', 'Canada', 'flat', 95.00),
        ('${fId}', NULL, 'flat', 120.00);
      `);
    }

    console.log("✅ REALISTIC FACTORIES & PRODUCTS SEEDED!");
    console.log(`1. GreenCup Packaging ID:  ${f1}`);
    console.log(`2. Apex Box Works ID:      ${f2}`);
    console.log(`3. Nova Merch ID:          ${f3}\n`);

  } catch (error) {
    console.error("❌ Seeding failed:", error);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();