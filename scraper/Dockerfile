FROM public.ecr.aws/lambda/nodejs:18

COPY package.json ./
RUN npm install --omit=dev

COPY handler.js ./

CMD ["handler.handler"]
