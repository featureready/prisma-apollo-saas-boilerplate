import bcrypt from 'bcrypt';
import jsonwebtoken from 'jsonwebtoken';
import uuidv4 from 'uuid/v4';
import { UserInputError, AuthenticationError } from 'apollo-server';
import sendEmail from '../services/sendgrid';
import {
  createCustomer,
  createCard,
  createSubscription,
  listAllInvoices
} from '../services/stripe';
import { toCamelCase } from '../helpers/arrayUtils';
import { validateUser } from '../validators/user';

export default {
  Query: {
    async Me(parent, args, { user, prisma }, info) {
      return prisma.user({ id: user.id });
    },
    async PaymentHistory(parent, args, context, info) {
      const { stripeCustomerId: customerId } = context.user;
      const invoices = await listAllInvoices({
        customerId
      });

      return toCamelCase(invoices);
    }
  },
  Mutation: {
    async Signup(parent, { input }, { prisma }, info) {
      await validateUser(input);

      const { firstName, lastName, email, password, inviteId } = input;
      const existingUser = await prisma.user({ email });
      let team = null;

      if (existingUser) {
        throw new UserInputError('Email is already taken');
      } else {
        if (inviteId) {
          const invitedTeam = await prisma.invite({ id: inviteId }).team();
          if (invitedTeam) {
            team = {
              connect: {
                id: invitedTeam.id
              }
            };
          }
        }

        const user = await prisma.createUser({
          firstName,
          lastName,
          email,
          password: hashedPassword(password),
          stripeCustomerId: await createCustomer({ email }),
          team
        });

        return {
          user,
          jwt: getJwt({
            id: user.id,
            email: user.email
          })
        };
      }
    },
    async Login(
      parent,
      {
        input: { email, password }
      },
      { prisma },
      info
    ) {
      const user = await prisma.user({ email });

      if (user && bcrypt.compareSync(password, user.password)) {
        return {
          user,
          jwt: getJwt({
            id: user.id,
            email: user.email
          })
        };
      }

      throw new AuthenticationError('Please check your credentials and try again.');
    },
    async ForgotPassword(
      parent,
      {
        input: { email }
      },
      { prisma },
      info
    ) {
      const user = await prisma.user({ email });

      if (user) {
        const { email: userEmail } = user;
        const token = uuidv4();

        await prisma.updateUser({
          where: { email },
          data: { resetPasswordToken: token }
        });

        sendEmail({
          template_id: process.env.FORGOT_PASSWORD_TEMPLATE_ID,
          to: userEmail,
          from: process.env.SUPPORT_EMAIL_ADDRESS,
          dynamic_template_data: {
            email: userEmail,
            resetPasswordLink: `https://app.zapcms.com/reset-password?token=${token}`
          }
        });
      }

      return {
        message: 'A link to reset your password will be sent to your registered email.'
      };
    },
    async ResetPassword(
      parent,
      {
        input: { password, token }
      },
      { prisma },
      info
    ) {
      const dbUser = await prisma.user({ resetPasswordToken: token });

      if (dbUser) {
        await prisma.updateUser({
          where: { resetPasswordToken: token },
          data: {
            password: hashedPassword(password),
            resetPasswordToken: null
          }
        });

        return {
          message: 'Password updated successfully.'
        };
      }

      throw new AuthenticationError('Password reset token is invalid.');
    },
    async UpdateUser(parent, { input }, { user, prisma }, info) {
      await validateUser(input);

      const { firstName, lastName, email, password } = input;

      if (password) {
        return prisma.updateUser({
          where: { id: user.id },
          data: {
            firstName,
            lastName,
            email,
            password: hashedPassword(password)
          }
        });
      }

      return prisma.updateUser({
        where: { id: user.id },
        data: {
          firstName,
          lastName,
          email
        }
      });
    },
    async DeleteUser(
      parent,
      args,
      {
        user: { id },
        prisma
      },
      info
    ) {
      return prisma.deleteUser({ id });
    },
    async AddCreditCard(
      parent,
      {
        input: { token }
      },
      context,
      info
    ) {
      const { stripeCustomerId: customerId } = context.user;

      await createCard({
        token,
        customerId
      });

      return {
        message: 'Successfully updated billing information.'
      };
    },
    async SubscribePlan(
      parent,
      {
        input: { planId }
      },
      context,
      info
    ) {
      const { stripeCustomerId: customerId } = context.user;

      await createSubscription({
        planId,
        customerId
      });

      return {
        message: 'Successfully subscribed to plan.'
      };
    }
  }
};

const hashedPassword = password => bcrypt.hashSync(password, 10);
const getJwt = ({ id, email }) => jsonwebtoken.sign({ id, email }, process.env.JWT_SECRET);
