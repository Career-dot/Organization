const Container = ({ className = "", children }) => (
  <div className={`mx-auto w-full max-w-7xl px-6 lg:px-8 ${className}`}>
    {children}
  </div>
);

export default Container;
