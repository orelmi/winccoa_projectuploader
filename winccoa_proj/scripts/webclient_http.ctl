#uses "classes/MyHttpServer"

MyHttpServer http;

main()
{
  int MAXLENGTH = 100 * 1024 * 1024;
  http.start();
  httpSetMaxContentLength(MAXLENGTH);
}
