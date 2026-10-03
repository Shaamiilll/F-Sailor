import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { findUserByEmail, findUserById, findFactoryById } from "./db.service";
import { JwtPayload } from "../types";
import * as subscriptions from "./subscription.service";

/**
 * The subscription facts the frontend needs right after sign-in, so it can send
 * an unpaid or lapsed account to checkout instead of a dashboard that would
 * answer 402 to everything.
 */
async function subscriptionSummary(factoryId: string | null) {
  if (!factoryId) return null;
  const sub = await subscriptions.getSubscription(factoryId);
  if (!sub) return null;
  return {
    plan: sub.plan,
    interval: sub.interval,
    status: sub.status,
    usable: subscriptions.isUsable(sub.status),
    provisionedBy: sub.provisionedBy,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
  };
}

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
    subscription: await subscriptionSummary(user.factoryId),
    factory: factory
      ? {
          id: factory.id,
          name: factory.name,
          type: factory.type,
          country: factory.country,
          email: factory.email,
          phone: factory.phone,
          username: factory.username,
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
        username: f.username,
      };
    }
  }

  return {
    id: user.id,
    email: user.email,
    role: user.role,
    factoryId: user.factoryId,
    factory,
    subscription: await subscriptionSummary(user.factoryId),
  };
}
