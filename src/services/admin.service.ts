import bcrypt from "bcryptjs";
import {
  createFactoryWithUser,
  findAllFactories,
} from "./db.service";
import { CreateFactoryInput } from "../types";

export async function listFactories() {
  const factories = await findAllFactories();
  return factories.map((f) => ({
    id: f.id,
    name: f.name,
    type: f.type,
    country: f.country,
    email: f.email,
    phone: f.phone,
    createdAt: f.createdAt,
  }));
}

export async function createFactory(input: CreateFactoryInput) {
  const passwordHash = await bcrypt.hash(input.password, 10);

  const { factory, user } = await createFactoryWithUser(
    {
      name: input.name,
      type: input.type,
      country: input.country,
      email: input.email,
      phone: input.phone,
    },
    passwordHash
  );

  return {
    factory: {
      id: factory.id,
      name: factory.name,
      type: factory.type,
      country: factory.country,
      email: factory.email,
      phone: factory.phone,
    },
    loginEmail: user.email,
  };
}
