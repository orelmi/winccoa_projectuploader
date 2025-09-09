#uses "classes/httpprojectuploader/ProjectUploaderHttpEndpoints"
#uses "classes/HttpServer"
#uses "std"
#uses "CtrlXml"
#uses "CtrlHTTP"
#uses "CtrlPv2Admin"

/* Base Implementation for the HTTP server features needed for
   the UserInterface running on mobile clients and as Desktop-UI
*/

class MyHttpServer : HttpServer
{
  public MyHttpServer() : HttpServer()
  {
  }

  /* start the http server and open the listener ports
     @return 0 when the server could start and open all ports, otherwise < 0
  */
  public int start()
  {
    HttpServer::start();
    ProjectUploaderHttpEndpoints::connectEndpoints(this.getHttpsPort());
  }
};

//--------------------------------------------------------------------------------
