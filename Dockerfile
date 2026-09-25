FROM node:22-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

RUN mkdir -p uploads

EXPOSE 4000

CMD ["npm", "start"]
