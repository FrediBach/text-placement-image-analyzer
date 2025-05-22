// Update this page (the content is just a fallback if you fail to update the page)
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

const Index = () => {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-100 p-4">
      <div className="text-center space-y-6">
        <h1 className="text-4xl font-bold mb-4">Welcome to Your Dyad App</h1>
        <p className="text-xl text-gray-600">
          Explore available tools and features.
        </p>
        <div>
          <Link to="/image-analyzer">
            <Button size="lg">Go to Image Analyzer</Button>
          </Link>
        </div>
      </div>
    </div>
  );
};

export default Index;