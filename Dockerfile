FROM node:26-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 7001
CMD ["npm", "run", "start"]
