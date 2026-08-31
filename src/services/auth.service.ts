import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { findUserByEmail, findUserById, findFactoryById } from "./db.service";
import { JwtPayload } from "../types";

export async function login(email: string, password: string) {
  const user = await findUserByEmail(email);
  if (!user) {
    throw new Error("Invalid email or password");
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    throw new Error("Invalid email or password");
  }

  const payload: JwtPayload = {
    userId: user.id,
    email: user.email,
    role: user.role,
    factoryId: user.factoryId,
  };

  const token = jwt.sign(payload, env.jwtSecret, { expiresIn: "7d" });

  let factory = null;
  if (user.factoryId) {
    factory = await findFactoryById(user.factoryId);
  }

  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      factoryId: user.factoryId,
    },
    factory: factory
      ? {
          id: factory.id,
          name: factory.name,
          type: factory.type,
          country: factory.country,
          email: factory.email,
          phone: factory.phone,
        }
      : null,
  };
}

export async function getMe(userId: string) {
  const user = await findUserById(userId);
  if (!user) throw new Error("User not found");

  let factory = null;
  if (user.factoryId) {
    const f = await findFactoryById(user.factoryId);
    if (f) {
      factory = {
        id: f.id,
        name: f.name,
        type: f.type,
        country: f.country,
        email: f.email,
        phone: f.phone,
      };
    }
  }

  return {
    id: user.id,
    email: user.email,
    role: user.role,
    factoryId: user.factoryId,
    factory,
  };
}
